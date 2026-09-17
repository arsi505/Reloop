import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Param,
  Body,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SimulatorStateService } from '../state/simulator-state.service';
import { ShopifyOrder, FulfillmentStatus } from '@reloop/connector-simulator';

@Controller('shopify')
export class ShopifyController {
  constructor(private readonly stateService: SimulatorStateService) {}

  @Get('health')
  getHealth() {
    return { status: 'ok', provider: 'shopify' };
  }

  @Post('orders')
  @HttpCode(HttpStatus.CREATED)
  createOrder(@Body() orderDto: Partial<ShopifyOrder>): ShopifyOrder {
    const now = new Date().toISOString();
    const id = orderDto.id || `shp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const orderNumber = orderDto.orderNumber || `ORD-${Math.floor(1000 + Math.random() * 9000)}`;

    const order: ShopifyOrder = {
      id,
      orderNumber,
      customer: orderDto.customer || { name: 'Sample Customer', email: 'cust@example.com' },
      shippingAddress: orderDto.shippingAddress || {
        street: '123 Main St',
        city: 'Anytown',
        state: 'CA',
        postalCode: '90001',
        country: 'US',
      },
      lineItems: orderDto.lineItems || [],
      paymentStatus: orderDto.paymentStatus || 'PAID',
      fulfillmentStatus: orderDto.fulfillmentStatus || 'UNFULFILLED',
      trackingNumber: orderDto.trackingNumber,
      carrier: orderDto.carrier,
      createdAt: orderDto.createdAt || now,
      updatedAt: now,
    };

    return this.stateService.saveShopifyOrder(order);
  }

  @Get('orders')
  listOrders(): ShopifyOrder[] {
    return this.stateService.listShopifyOrders();
  }

  @Get('orders/:id')
  getOrder(@Param('id') id: string): ShopifyOrder {
    const order = this.stateService.getShopifyOrder(id) || this.stateService.getShopifyOrderByNumber(id);
    if (!order) {
      throw new NotFoundException(`Shopify order not found: ${id}`);
    }
    return order;
  }

  @Patch('orders/:id/fulfill')
  fulfillOrder(
    @Param('id') id: string,
    @Body() body: { trackingNumber?: string; carrier?: string; fulfillmentStatus?: FulfillmentStatus },
  ): ShopifyOrder {
    const order = this.stateService.getShopifyOrder(id) || this.stateService.getShopifyOrderByNumber(id);
    if (!order) {
      throw new NotFoundException(`Shopify order not found: ${id}`);
    }

    order.fulfillmentStatus = body.fulfillmentStatus || 'FULFILLED';
    if (body.trackingNumber) order.trackingNumber = body.trackingNumber;
    if (body.carrier) order.carrier = body.carrier;
    order.updatedAt = new Date().toISOString();

    return this.stateService.saveShopifyOrder(order);
  }

  @Get('inventory/:sku')
  getInventory(@Param('sku') sku: string) {
    const quantity = this.stateService.getShopifyInventory(sku);
    if (quantity === undefined) {
      throw new NotFoundException(`SKU not found in Shopify inventory: ${sku}`);
    }
    return { sku, quantity, provider: 'shopify' };
  }

  @Put('inventory/:sku')
  setInventory(@Param('sku') sku: string, @Body() body: { quantity: number }) {
    this.stateService.setShopifyInventory(sku, body.quantity);
    return { sku, quantity: body.quantity, provider: 'shopify' };
  }
}