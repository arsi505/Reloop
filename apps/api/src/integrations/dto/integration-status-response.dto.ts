export class IntegrationStatusResponseDto {
  id!: string;
  organizationId!: string;
  provider!: string;
  name!: string;
  status!: string;
  mode!: string;
  shopDomain?: string | null;
  scopes?: string[];
  createdAt!: Date;
  updatedAt!: Date;
}
