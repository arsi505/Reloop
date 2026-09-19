import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ShopifySyncService } from './shopify-sync.service';
import { ShopifyTokenRefreshService } from './shopify-token-refresh.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ShopifySyncService (Read-Only Order & Fulfillment Sync)', () => {
  let service: ShopifySyncService;
  let prisma: any;
  let tokenRefresh: any;

  beforeEach(async () => {
    prisma = {
      integration: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      job: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      externalOrder: {
        upsert: jest.fn().mockImplementation(({ create }: any) => ({
          id: 'ext-order-id-1',
          ...create,
        })),
      },
      externalReference: {
        upsert: jest.fn().mockImplementation(({ create }: any) => ({
          id: 'ext-ref-id-1',
          ...create,
        })),
      },
    };

    tokenRefresh = {
      getValidAccessToken: jest.fn().mockResolvedValue('shpat_valid_token_123'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShopifySyncService,
        { provide: PrismaService, useValue: prisma },
        { provide: ShopifyTokenRefreshService, useValue: tokenRefresh },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'shopifyInitialSyncMaxOrders') return 100;
              if (key === 'shopifyApiVersion') return '2026-07';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ShopifySyncService>(ShopifySyncService);
  });

  it('paginates across 2 pages and projects orders idempotently', async () => {
    prisma.integration.findUnique.mockResolvedValue({
      id: 'int-sync-1',
      organizationId: 'org-sync-1',
      shopDomain: 'store.myshopify.com',
    });

    const page1Orders = [
      {
        id: 'gid://shopify/Order/101',
        name: '#101',
        createdAt: '2026-07-01T10:00:00Z',
        updatedAt: '2026-07-01T10:05:00Z',
        displayFulfillmentStatus: 'UNFULFILLED',
        displayFinancialStatus: 'PAID',
        cancelledAt: null,
        totalPriceSet: { shopMoney: { amount: '45.00', currencyCode: 'USD' } },
        lineItems: { edges: [{ node: { id: 'gid://shopify/LineItem/1', sku: 'SKU-A', quantity: 1, title: 'Item A' } }] },
        fulfillments: [],
      },
    ];

    const page2Orders = [
      {
        id: 'gid://shopify/Order/102',
        name: '#102',
        createdAt: '2026-07-01T11:00:00Z',
        updatedAt: '2026-07-01T11:15:00Z',
        displayFulfillmentStatus: 'FULFILLED',
        displayFinancialStatus: 'PAID',
        cancelledAt: null,
        totalPriceSet: { shopMoney: { amount: '80.00', currencyCode: 'USD' } },
        lineItems: { edges: [{ node: { id: 'gid://shopify/LineItem/2', sku: 'SKU-B', quantity: 2, title: 'Item B' } }] },
        fulfillments: [
          {
            id: 'gid://shopify/Fulfillment/201',
            status: 'SUCCESS',
            createdAt: '2026-07-01T11:10:00Z',
            updatedAt: '2026-07-01T11:12:00Z',
            trackingInfo: [{ number: 'TRACK-201', company: 'FedEx', url: 'https://fedex.com' }],
          },
        ],
      },
    ];

    const mockFetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            orders: {
              edges: page1Orders.map((o) => ({ node: o })),
              pageInfo: {
                hasNextPage: true,
                endCursor: 'cursor_page_1',
              },
            },
          },
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            orders: {
              edges: page2Orders.map((o) => ({ node: o })),
              pageInfo: {
                hasNextPage: false,
                endCursor: 'cursor_page_2',
              },
            },
          },
        }),
      } as any);

    const result = await service.syncRecentOrders('int-sync-1', { fetchFn: mockFetch });

    expect(result.totalOrdersSynced).toBe(2);
    expect(result.pagesProcessed).toBe(2);
    expect(result.complete).toBe(true);

    // Verify external orders projected via upsert (idempotent)
    expect(prisma.externalOrder.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.externalReference.upsert).toHaveBeenCalledTimes(3); // 2 orders + 1 fulfillment
  });

  it('handles empty store gracefully', async () => {
    prisma.integration.findUnique.mockResolvedValue({
      id: 'int-empty',
      organizationId: 'org-empty',
      shopDomain: 'empty.myshopify.com',
    });

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          orders: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as any);

    const result = await service.syncRecentOrders('int-empty', { fetchFn: mockFetch });
    expect(result.totalOrdersSynced).toBe(0);
    expect(result.pagesProcessed).toBe(1);
    expect(prisma.externalOrder.upsert).not.toHaveBeenCalled();
  });

  describe('Durable Job Processing & Crash-Recovery', () => {
    it('processSyncJob executes sync, marks job SUCCEEDED, and updates integration', async () => {
      prisma.job.findUnique.mockResolvedValue({
        id: 'job-sync-1',
        type: 'SHOPIFY_SYNC_ORDERS',
        status: 'QUEUED',
        payload: {
          integrationId: 'int-sync-job',
          shopDomain: 'store.myshopify.com',
        },
      });

      prisma.integration.findUnique.mockResolvedValue({
        id: 'int-sync-job',
        organizationId: 'org-1',
        shopDomain: 'store.myshopify.com',
        configuration: { initialSyncStatus: 'PENDING' },
      });

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/Order/101',
                    name: '#101',
                    createdAt: '2026-09-01T10:00:00Z',
                    updatedAt: '2026-09-01T10:00:00Z',
                    displayFulfillmentStatus: 'UNFULFILLED',
                    displayFinancialStatus: 'PAID',
                    totalPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'USD' } },
                    lineItems: { edges: [] },
                    fulfillments: [],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      } as any);

      const res = await service.processSyncJob('job-sync-1', { fetchFn: mockFetch });
      expect(res.totalOrdersSynced).toBe(1);

      // Verify job transitioned to RUNNING then SUCCEEDED
      expect(prisma.job.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-sync-1' },
          data: expect.objectContaining({ status: 'RUNNING' }),
        }),
      );
      expect(prisma.job.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-sync-1' },
          data: expect.objectContaining({ status: 'SUCCEEDED' }),
        }),
      );

      // Verify Integration updated with COMPLETED
      expect(prisma.integration.update).toHaveBeenCalledWith({
        where: { id: 'int-sync-job' },
        data: {
          configuration: expect.objectContaining({
            initialSyncStatus: 'COMPLETED',
            lastSyncOrdersCount: 1,
          }),
        },
      });
    });

    it('processPendingSyncJobs sweeps queued jobs on process recovery', async () => {
      prisma.job.findMany.mockResolvedValue([
        {
          id: 'job-pending-1',
          type: 'SHOPIFY_SYNC_ORDERS',
          status: 'QUEUED',
          payload: { integrationId: 'int-pending-1', shopDomain: 'store.myshopify.com' },
        },
      ]);

      prisma.job.findUnique.mockResolvedValue({
        id: 'job-pending-1',
        type: 'SHOPIFY_SYNC_ORDERS',
        status: 'QUEUED',
        payload: { integrationId: 'int-pending-1', shopDomain: 'store.myshopify.com' },
      });

      prisma.integration.findUnique.mockResolvedValue({
        id: 'int-pending-1',
        organizationId: 'org-1',
        shopDomain: 'store.myshopify.com',
      });

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            orders: {
              edges: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      } as any);

      const sweepResult = await service.processPendingSyncJobs({ fetchFn: mockFetch });
      expect(sweepResult.processed).toBe(1);
      expect(sweepResult.successful).toBe(1);
      expect(sweepResult.failed).toBe(0);
    });

    it('sync retry is idempotent: multiple executions on same order preserve deterministic identity', async () => {
      prisma.integration.findUnique.mockResolvedValue({
        id: 'int-idempotent',
        organizationId: 'org-idem',
        shopDomain: 'store.myshopify.com',
      });

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/Order/999',
                    name: '#999',
                    createdAt: '2026-09-01T10:00:00Z',
                    updatedAt: '2026-09-01T10:00:00Z',
                    displayFulfillmentStatus: 'UNFULFILLED',
                    displayFinancialStatus: 'PAID',
                    totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } },
                    lineItems: { edges: [] },
                    fulfillments: [],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      } as any);

      // Execute initial sync
      await service.syncRecentOrders('int-idempotent', { fetchFn: mockFetch });

      // Retry same sync request (e.g. at-least-once replay)
      await service.syncRecentOrders('int-idempotent', { fetchFn: mockFetch });

      // Both executions call upsert targeting exact same unique keys
      expect(prisma.externalOrder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId_externalOrderNumber: {
              organizationId: 'org-idem',
              externalOrderNumber: '999',
            },
          },
        }),
      );

      expect(prisma.externalReference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId_integrationId_resourceType_externalId: {
              organizationId: 'org-idem',
              integrationId: 'int-idempotent',
              resourceType: 'ORDER',
              externalId: 'gid://shopify/Order/999',
            },
          },
        }),
      );
    });
  });
});
