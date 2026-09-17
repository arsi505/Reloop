import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SimulatorStateService } from '../state/simulator-state.service';
import { ShipStationShipment, ShippingStatus } from '@reloop/connector-simulator';

@Controller('shipstation')
export class ShipStationController {
  constructor(private readonly stateService: SimulatorStateService) {}

  @Get('health')
  getHealth() {
    return { status: 'ok', provider: 'shipstation' };
  }

  @Post('shipments')
  @HttpCode(HttpStatus.CREATED)
  createShipment(@Body() shipmentDto: Partial<ShipStationShipment>): ShipStationShipment {
    const now = new Date().toISOString();
    const id = shipmentDto.id || `ship_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const orderNumber = shipmentDto.orderNumber || `ORD-${Math.floor(1000 + Math.random() * 9000)}`;

    const shipment: ShipStationShipment = {
      id,
      orderNumber,
      carrier: shipmentDto.carrier || 'UPS',
      trackingNumber: shipmentDto.trackingNumber || `TRK-${Math.floor(10000000 + Math.random() * 90000000)}`,
      status: shipmentDto.status || 'LABEL_CREATED',
      shippingAddress: shipmentDto.shippingAddress || {
        street: '123 Main St',
        city: 'Anytown',
        state: 'CA',
        postalCode: '90001',
        country: 'US',
      },
      createdAt: shipmentDto.createdAt || now,
      updatedAt: now,
    };

    return this.stateService.saveShipment(shipment);
  }

  @Get('shipments')
  listShipments(): ShipStationShipment[] {
    return this.stateService.listShipments();
  }

  @Get('shipments/:id')
  getShipment(@Param('id') id: string): ShipStationShipment {
    const shipment = this.stateService.getShipment(id);
    if (!shipment) {
      throw new NotFoundException(`ShipStation shipment not found: ${id}`);
    }
    return shipment;
  }

  @Get('shipments/by-order/:orderNumber')
  getShipmentByOrder(@Param('orderNumber') orderNumber: string): ShipStationShipment {
    const shipment = this.stateService.getShipmentByOrderNumber(orderNumber);
    if (!shipment) {
      throw new NotFoundException(`ShipStation shipment not found for order: ${orderNumber}`);
    }
    return shipment;
  }

  @Patch('shipments/:id/tracking')
  updateTracking(
    @Param('id') id: string,
    @Body() body: { trackingNumber?: string; carrier?: string; status?: ShippingStatus },
  ): ShipStationShipment {
    const shipment = this.stateService.getShipment(id);
    if (!shipment) {
      throw new NotFoundException(`ShipStation shipment not found: ${id}`);
    }

    if (body.trackingNumber) shipment.trackingNumber = body.trackingNumber;
    if (body.carrier) shipment.carrier = body.carrier;
    if (body.status) shipment.status = body.status;
    shipment.updatedAt = new Date().toISOString();

    return this.stateService.saveShipment(shipment);
  }
}