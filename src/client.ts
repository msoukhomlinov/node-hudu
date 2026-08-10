/**
 * HuduClient — top-level facade wiring all resource clients.
 */
import { resolveConfig, type HuduConfig, type ResolvedConfig } from './config.js';
import { HttpClient } from './http.js';
import {
  ActivityLogsResource, ApiInfoResource, ArticlesResource, AssetLayoutsResource,
  AssetPasswordsResource, AssetsResource, CardsResource, CompaniesResource,
  ExpirationsResource, ExportsResource, FlagTypesResource, FlagsResource,
  FoldersResource, GroupsResource, IpAddressesResource, LabelTypesResource,
  LabelsResource, ListsResource, MagicDashResource, MatchersResource,
  NetworksResource, PasswordFoldersResource, PhotosResource,
  ProcedureTasksResource, ProceduresResource, PublicPhotosResource,
  RackStorageItemsResource, RackStoragesResource, RelationsResource,
  S3ExportsResource, UploadsResource, UsersResource, VlanZonesResource,
  VlansResource, WebsitesResource,
} from './resources/index.js';

export class HuduClient {
  readonly companies: CompaniesResource;
  readonly articles: ArticlesResource;
  readonly assetLayouts: AssetLayoutsResource;
  readonly assetPasswords: AssetPasswordsResource;
  readonly assets: AssetsResource;
  readonly expirations: ExpirationsResource;
  readonly exports: ExportsResource;
  readonly flagTypes: FlagTypesResource;
  readonly flags: FlagsResource;
  readonly folders: FoldersResource;
  readonly groups: GroupsResource;
  readonly ipAddresses: IpAddressesResource;
  readonly labelTypes: LabelTypesResource;
  readonly labels: LabelsResource;
  readonly lists: ListsResource;
  readonly magicDash: MagicDashResource;
  readonly matchers: MatchersResource;
  readonly networks: NetworksResource;
  readonly passwordFolders: PasswordFoldersResource;
  readonly photos: PhotosResource;
  readonly procedureTasks: ProcedureTasksResource;
  readonly procedures: ProceduresResource;
  readonly publicPhotos: PublicPhotosResource;
  readonly rackStorageItems: RackStorageItemsResource;
  readonly rackStorages: RackStoragesResource;
  readonly relations: RelationsResource;
  readonly s3Exports: S3ExportsResource;
  readonly uploads: UploadsResource;
  readonly users: UsersResource;
  readonly vlanZones: VlanZonesResource;
  readonly vlans: VlansResource;
  readonly websites: WebsitesResource;
  readonly apiInfo: ApiInfoResource;
  readonly activityLogs: ActivityLogsResource;
  readonly cards: CardsResource;

  readonly config: ResolvedConfig;
  private readonly http: HttpClient;

  constructor(config: HuduConfig) {
    this.config = resolveConfig(config);
    this.http = new HttpClient(this.config);

    this.companies = new CompaniesResource(this.http);
    this.articles = new ArticlesResource(this.http);
    this.assetLayouts = new AssetLayoutsResource(this.http);
    this.assetPasswords = new AssetPasswordsResource(this.http);
    this.assets = new AssetsResource(this.http);
    this.expirations = new ExpirationsResource(this.http);
    this.exports = new ExportsResource(this.http);
    this.flagTypes = new FlagTypesResource(this.http);
    this.flags = new FlagsResource(this.http);
    this.folders = new FoldersResource(this.http);
    this.groups = new GroupsResource(this.http);
    this.ipAddresses = new IpAddressesResource(this.http);
    this.labelTypes = new LabelTypesResource(this.http);
    this.labels = new LabelsResource(this.http);
    this.lists = new ListsResource(this.http);
    this.magicDash = new MagicDashResource(this.http);
    this.matchers = new MatchersResource(this.http);
    this.networks = new NetworksResource(this.http);
    this.passwordFolders = new PasswordFoldersResource(this.http);
    this.photos = new PhotosResource(this.http);
    this.procedureTasks = new ProcedureTasksResource(this.http);
    this.procedures = new ProceduresResource(this.http);
    this.publicPhotos = new PublicPhotosResource(this.http);
    this.rackStorageItems = new RackStorageItemsResource(this.http);
    this.rackStorages = new RackStoragesResource(this.http);
    this.relations = new RelationsResource(this.http);
    this.s3Exports = new S3ExportsResource(this.http);
    this.uploads = new UploadsResource(this.http);
    this.users = new UsersResource(this.http);
    this.vlanZones = new VlanZonesResource(this.http);
    this.vlans = new VlansResource(this.http);
    this.websites = new WebsitesResource(this.http);
    this.apiInfo = new ApiInfoResource(this.http);
    this.activityLogs = new ActivityLogsResource(this.http);
    this.cards = new CardsResource(this.http);
  }
}
