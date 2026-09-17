import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Param,
  Query,
  Body,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SimulatorStateService } from '../state/simulator-state.service';
import { WarehouseOrder, WarehouseStatus } from '@reloop/connector-simulator';

@Controller('3pl')
export class ThreePlController {
  constructor(private readonly stateService: SimulatorStateService) {}

  @Get('health')
  getHealth() {
    return { status: 'ok', provider: '3pl' };
  }

  @Post('orders')
  @HttpCode(HttpStatus.CREATED)
  submitOrder(@Body() orderDto: Partial<WarehouseOrder>): WarehouseOrder {
    const now = new Date().toISOString();
    const id = orderDto.id || `wh_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const orderNumber = orderDto.orderNumber || `ORD-${Math.floor(1000 + Math.random() * 9000)}`;

    // Business validation for invalid SKU
    if (orderDto.lineItems && orderDto.lineItems.some((item) => item.sku && item.sku.includes('INVALID'))) {
      throw new UnprocessableEntityException({
        error: {
          code: 'INVALID_SKU',
          message: 'Specified SKU is unrecognized or discontinued in warehouse catalog',
          retryable: false,
        },
      });
    }

    // Business validation for invalid address
    if (orderDto.shippingAddress && (orderDto.shippingAddress.postalCode === '00000' || orderDto.shippingAddress.postalCode === 'INVALID')) {
      throw new UnprocessableEntityException({
        error: {
          code: 'INVALID_ADDRESS',
          message: 'Shipping address postal code or format is invalid',
          retryable: false,
        },
      });
    }

    // Duplicate detection
    const existingByNum = this.stateService.getWarehouseOrderByNumber(orderNumber);
    if (existingByNum) {
      throw new ConflictException({
        error: {
          code: 'DUPLICATE_ORDER',
          message: `Order ${orderNumber} already exists in warehouse`,
          retryable: false,
        },
      });
    }

    if (orderDto.externalReference) {
      const existingByRef = this.stateService.getWarehouseOrderByRef(orderDto.externalReference);
      if (existingByRef) {
        throw new ConflictException({
          error: {
            code: 'DUPLICATE_ORDER',
            message: `Order with reference ${orderDto.externalReference} already exists in warehouse`,
            retryable: false,
          },
        });
      }
    }

    const order: WarehouseOrder = {
      id,
      orderNumber,
      externalReference: orderDto.externalReference,
      customer: orderDto.customer || { name: 'Customer', email: 'cust@example.com' },
      shippingAddress: orderDto.shippingAddress || {
        street: '123 Main St',
        city: 'Anytown',
        state: 'CA',
        postalCode: '90001',
        country: 'US',
      },
      lineItems: orderDto.lineItems || [],
      status: orderDto.status || 'RECEIVED',
      trackingNumber: orderDto.trackingNumber,
      carrier: orderDto.carrier,
      createdAt: orderDto.createdAt || now,
      updatedAt: now,
    };

    return this.stateService.saveWarehouseOrder(order);
  }

  @Get('orders')
  listOrders(): WarehouseOrder[] {
    return this.stateService.listWarehouseOrders();
  }

  // NOTE: /3pl/orders/search MUST precede /3pl/orders/:id in route ordering!
  @Get('orders/search')
  searchOrders(
    @Query('orderNumber') orderNumber?: string,
    @Query('reference') reference?: string,
  ): WarehouseOrder {
    if (orderNumber) {
      const order = this.stateService.getWarehouseOrderByNumber(orderNumber);
      if (order) return order;
    }

    if (reference) {
      const order = this.stateService.getWarehouseOrderByRef(reference);
      if (order) return order;
    }

    throw new NotFoundException({
      error: {
        code: 'ORDER_NOT_FOUND',
        message: 'Order matching search query not found in warehouse',
        retryable: false,
      },
    });
  }

  @Get('orders/:id')
  getOrder(@Param('id') id: string): WarehouseOrder {
    const order = this.stateService.getWarehouseOrder(id) || this.stateService.getWarehouseOrderByNumber(id);
    if (!order) {
      throw new NotFoundException({
        error: {
          code: 'ORDER_NOT_FOUND',
          message: `Warehouse order not found: ${id}`,
          retryable: false,
        },
      });
    }
    return order;
  }

  @Patch('orders/:id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() body: { status: WarehouseStatus; trackingNumber?: string; carrier?: string },
  ): WarehouseOrder {
    const validStatuses: readonly WarehouseStatus[] = [
      'RECEIVED',
      'PENDING_FULFILLMENT',
      'PICKING',
      'PACKED',
      'SHIPPED',
      'DELIVERED',
      'REJECTED',
      'CANCELLED',
    ];

    if (!body.status || !validStatuses.includes(body.status)) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_STATUS',
          message: `Invalid warehouse status: ${body.status}. Valid statuses: ${validStatuses.join(', ')}`,
          retryable: false,
        },
      });
    }

    const order = this.stateService.getWarehouseOrder(id) || this.stateService.getWarehouseOrderByNumber(id);
    if (!order) {
      throw new NotFoundException({
        error: {
          code: 'ORDER_NOT_FOUND',
          message: `Warehouse order not found: ${id}`,
          retryable: false,
        },
      });
    }

    order.status = body.status;
    if (body.trackingNumber) order.trackingNumber = body.trackingNumber;
    if (body.carrier) order.carrier = body.carrier;
    order.updatedAt = new Date().toISOString();

    return this.stateService.saveWarehouseOrder(order);
  }

  @Get('inventory/:sku')
  getInventory(@Param('sku') sku: string) {
    const quantity = this.stateService.getWarehouseInventory(sku);
    if (quantity === undefined) {
      throw new NotFoundException({
        error: {
          code: 'INVALID_SKU',
          message: `SKU not found in 3PL inventory: ${sku}`,
          retryable: false,
        },
      });
    }
    return { sku, quantity, provider: '3pl' };
  }

  @Put('inventory/:sku')
  setInventory(@Param('sku') sku: string, @Body() body: { quantity: number }) {
    this.stateService.setWarehouseInventory(sku, body.quantity);
    return { sku, quantity: body.quantity, provider: '3pl' };
  }
}