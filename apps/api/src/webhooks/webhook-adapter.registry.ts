import { Injectable, BadRequestException } from '@nestjs/common';
import { WebhookAdapter } from '@reloop/integration-sdk';
import { SimulatorWebhookAdapter } from '@reloop/connector-simulator';
import { ShopifyWebhookAdapter } from '@reloop/connector-shopify';

@Injectable()
export class WebhookAdapterRegistry {
  private readonly adapters = new Map<string, WebhookAdapter>();

  constructor() {
    const simulatorAdapter = new SimulatorWebhookAdapter();
    const shopifyAdapter = new ShopifyWebhookAdapter();

    this.adapters.set('SIMULATOR', simulatorAdapter);
    this.adapters.set('SHOPIFY', shopifyAdapter);
    this.adapters.set('SHIPSTATION', simulatorAdapter);
    this.adapters.set('GENERIC_3PL', simulatorAdapter);
  }

  getAdapter(provider: string): WebhookAdapter {
    const key = (provider || '').toUpperCase();
    const adapter = this.adapters.get(key);
    if (!adapter) {
      throw new BadRequestException(`Unsupported webhook provider: ${provider}`);
    }
    return adapter;
  }

  hasAdapter(provider: string): boolean {
    return this.adapters.has((provider || '').toUpperCase());
  }

  registerAdapter(provider: string, adapter: WebhookAdapter): void {
    this.adapters.set(provider.toUpperCase(), adapter);
  }
}
