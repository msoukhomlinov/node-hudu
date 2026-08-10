/**
 * Resource client barrel for node-hudu.
 */
export { BaseResource } from './base.js';
import { ActivityLogsResource } from './activity_logs.js';
import { ApiInfoResource } from './api_info.js';
import { ArticlesResource } from './articles.js';
import { AssetLayoutsResource } from './asset_layouts.js';
import { AssetPasswordsResource } from './asset_passwords.js';
import { AssetsResource } from './assets.js';
import { CardsResource } from './cards.js';
import { CompaniesResource } from './companies.js';
import { ExpirationsResource } from './expirations.js';
import { ExportsResource } from './exports.js';
import { FlagTypesResource } from './flag_types.js';
import { FlagsResource } from './flags.js';
import { FoldersResource } from './folders.js';
import { GroupsResource } from './groups.js';
import { IpAddressesResource } from './ip_addresses.js';
import { LabelTypesResource } from './label_types.js';
import { LabelsResource } from './labels.js';
import { ListsResource } from './lists.js';
import { MagicDashResource } from './magic_dash.js';
import { MatchersResource } from './matchers.js';
import { NetworksResource } from './networks.js';
import { PasswordFoldersResource } from './password_folders.js';
import { PhotosResource } from './photos.js';
import { ProcedureTasksResource } from './procedure_tasks.js';
import { ProceduresResource } from './procedures.js';
import { PublicPhotosResource } from './public_photos.js';
import { RackStorageItemsResource } from './rack_storage_items.js';
import { RackStoragesResource } from './rack_storages.js';
import { RelationsResource } from './relations.js';
import { S3ExportsResource } from './s3_exports.js';
import { UploadsResource } from './uploads.js';
import { UsersResource } from './users.js';
import { VlanZonesResource } from './vlan_zones.js';
import { VlansResource } from './vlans.js';
import { WebsitesResource } from './websites.js';

export { ActivityLogsResource } from './activity_logs.js';
export { ApiInfoResource } from './api_info.js';
export { ArticlesResource } from './articles.js';
export { AssetLayoutsResource } from './asset_layouts.js';
export { AssetPasswordsResource } from './asset_passwords.js';
export { AssetsResource } from './assets.js';
export { CardsResource } from './cards.js';
export { CompaniesResource } from './companies.js';
export { ExpirationsResource } from './expirations.js';
export { ExportsResource } from './exports.js';
export { FlagTypesResource } from './flag_types.js';
export { FlagsResource } from './flags.js';
export { FoldersResource } from './folders.js';
export { GroupsResource } from './groups.js';
export { IpAddressesResource } from './ip_addresses.js';
export { LabelTypesResource } from './label_types.js';
export { LabelsResource } from './labels.js';
export { ListsResource } from './lists.js';
export { MagicDashResource } from './magic_dash.js';
export { MatchersResource } from './matchers.js';
export { NetworksResource } from './networks.js';
export { PasswordFoldersResource } from './password_folders.js';
export { PhotosResource } from './photos.js';
export { ProcedureTasksResource } from './procedure_tasks.js';
export { ProceduresResource } from './procedures.js';
export { PublicPhotosResource } from './public_photos.js';
export { RackStorageItemsResource } from './rack_storage_items.js';
export { RackStoragesResource } from './rack_storages.js';
export { RelationsResource } from './relations.js';
export { S3ExportsResource } from './s3_exports.js';
export { UploadsResource } from './uploads.js';
export { UsersResource } from './users.js';
export { VlanZonesResource } from './vlan_zones.js';
export { VlansResource } from './vlans.js';
export { WebsitesResource } from './websites.js';

export const ALL_RESOURCE_CLASSES: Record<string, new (http: import('../http.js').HttpClient) => unknown> = {
  activity_logs: ActivityLogsResource,
  api_info: ApiInfoResource,
  articles: ArticlesResource,
  asset_layouts: AssetLayoutsResource,
  asset_passwords: AssetPasswordsResource,
  assets: AssetsResource,
  cards: CardsResource,
  companies: CompaniesResource,
  expirations: ExpirationsResource,
  exports: ExportsResource,
  flag_types: FlagTypesResource,
  flags: FlagsResource,
  folders: FoldersResource,
  groups: GroupsResource,
  ip_addresses: IpAddressesResource,
  label_types: LabelTypesResource,
  labels: LabelsResource,
  lists: ListsResource,
  magic_dash: MagicDashResource,
  matchers: MatchersResource,
  networks: NetworksResource,
  password_folders: PasswordFoldersResource,
  photos: PhotosResource,
  procedure_tasks: ProcedureTasksResource,
  procedures: ProceduresResource,
  public_photos: PublicPhotosResource,
  rack_storage_items: RackStorageItemsResource,
  rack_storages: RackStoragesResource,
  relations: RelationsResource,
  s3_exports: S3ExportsResource,
  uploads: UploadsResource,
  users: UsersResource,
  vlan_zones: VlanZonesResource,
  vlans: VlansResource,
  websites: WebsitesResource,
};
