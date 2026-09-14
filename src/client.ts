/**
 * HuduClient — top-level facade wiring all resource clients.
 */
import { ApiKeyAuth, isAuthStrategy, type AuthStrategy } from './auth.js';
import { resolveConfig, type HuduConfig, type ResolvedConfig } from './config.js';
import { HuduConfigError } from './errors.js';
import { HttpClient, type RateLimitStatus, type TransportState } from './http.js';
import { Operations } from './operations/index.js';
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

  /**
   * Cross-resource helpers (the `./operations` subpath): search several resources in one bounded
   * call, or resolve an identifier across them. Additive: the same class is importable directly.
   */
  readonly operations: Operations;

  readonly config: ResolvedConfig;
  private readonly http: HttpClient;

  /**
   * @param config Public configuration. Validated with `resolveConfig` unless `internal` is given.
   * @param internal INTERNAL, not part of the public API (issue #23): a pre-resolved config plus the
   * transport state to share. Used by `withAuth()` so a scoped client reuses the parent's rate-limit
   * bucket, queue, logger and audit hook instead of re-deriving them.
   */
  constructor(
    config: HuduConfig,
    internal?: { readonly config: ResolvedConfig; readonly state: TransportState },
  ) {
    if (internal) {
      this.config = internal.config;
      this.http = new HttpClient(internal.config, internal.state);
    } else {
      this.config = resolveConfig(config);
      this.http = new HttpClient(this.config);
    }

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
    this.operations = new Operations(this);
  }

  /**
   * Read-only snapshot of the client-side rate limiter and request queue, for callers that
   * apply their own backpressure — e.g. an MCP tool layer deciding whether to enqueue more work.
   *
   * Synchronous and side-effect free (see `RateLimitStatus`): it reports the transport's actual
   * local state (token-bucket estimate, queued callers, in-flight requests, the last honoured
   * `Retry-After`) and never acquires capacity. Purely additive.
   */
  getRateLimitStatus(): RateLimitStatus {
    return this.http.getRateLimitStatus();
  }

  /**
   * A client that shares this client's transport state (rate-limit bucket, queue, logger, audit
   * hook, timeouts, retries) and differs only in its credential. Cheap enough for a per-request
   * scope: a full client costs ~4 µs, so a per-request scope is a negligible fraction of a network
   * round trip.
   *
   * A bare string is an **API key** (`ApiKeyAuth`), preserving the SDK's historical wire shape —
   * never a bearer token. For a bearer token, pass one explicitly:
   * `client.withAuth(new BearerTokenAuth(token))`.
   *
   * Throws `HuduConfigError` (code `CONFIG_ERROR`) for an empty string or a non-strategy object;
   * issues no request.
   */
  withAuth(strategyOrToken: AuthStrategy | string): HuduClient {
    const auth: unknown = typeof strategyOrToken === 'string' ? new ApiKeyAuth(strategyOrToken) : strategyOrToken;
    if (!isAuthStrategy(auth)) {
      throw new HuduConfigError('withAuth requires an AuthStrategy or a non-empty apiKey string');
    }
    const config: ResolvedConfig = { ...this.config, apiKey: '', auth };
    return new HuduClient(config as unknown as HuduConfig, { config, state: this.http.state });
  }
}
