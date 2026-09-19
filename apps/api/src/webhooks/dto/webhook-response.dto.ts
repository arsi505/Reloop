export interface WebhookIngestResponseDto {
  status: 'accepted' | 'ignored_duplicate' | 'ignored_disconnected';
  eventId?: string;
  providerEventId: string;
  receivedAt: string;
}
