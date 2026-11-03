import type { PackageSyncStatus, ScriptingPackage } from "@wired-io/shared";
import type { PackageBaseline } from "../bridge/package-sync";
import { IDLE_ACTION, buildEntries, mergePackages, withoutRemoved } from "./model";
import type { PackageActionState, RoomPackageEntry } from "./model";

/**
 * Everything the package panel renders is derived from this reducer. Only a
 * load that still owns the newest request may dispatch: the previous
 * implementation mutated a `packagesRef` before checking whether its request
 * was still current, so a stale load could silently change the package list.
 */
type RoomPackagesState = {
  packages: ScriptingPackage[];
  entries: RoomPackageEntry[];
  actions: Record<number, PackageActionState>;
  /** Packages deleted in this session; stale props/polls must not bring them back. */
  removedIds: Set<number>;
  /** Package ids the status endpoint listed on the previous load. */
  remoteIds: Set<number>;
};

export type RoomPackagesAction =
  | { type: "reset"; packages: ScriptingPackage[] }
  | { type: "merged"; packages: ScriptingPackage[] }
  | { type: "created"; package: ScriptingPackage }
  | { type: "updated"; package: ScriptingPackage }
  | { type: "removed"; ids: number[] }
  | {
      type: "loaded";
      incoming: ScriptingPackage[];
      remote: Map<number, PackageSyncStatus>;
      baseline: Map<number, PackageBaseline>;
      snapshots: Map<number, Record<string, string>>;
      present: Set<number>;
    }
  | {
      type: "action";
      packageId: number;
      patch: Partial<PackageActionState>;
    };

export function roomPackagesReducer(
  state: RoomPackagesState,
  action: RoomPackagesAction,
): RoomPackagesState {
  switch (action.type) {
    case "reset":
      return {
        packages: action.packages,
        entries: [],
        actions: {},
        removedIds: new Set(),
        remoteIds: new Set(),
      };
    case "merged": {
      const packages = withoutRemoved(
        mergePackages(state.packages, action.packages, state.removedIds),
        state.removedIds,
      );
      return packages === state.packages ? state : { ...state, packages };
    }
    case "created": {
      const packages = withoutRemoved(
        mergePackages(state.packages, [action.package], state.removedIds),
        state.removedIds,
      );
      return packages === state.packages ? state : { ...state, packages };
    }
    case "updated": {
      // A PATCH that resolves after an explicit delete must not resurrect the
      // package, and an unknown package has nothing to update.
      if (state.removedIds.has(action.package.id)) return state;
      const index = state.packages.findIndex(
        (pkg) => pkg.id === action.package.id,
      );
      if (index === -1) return state;
      const packages = state.packages.slice();
      packages[index] = action.package;
      // Only metadata fields are copied into the entry: status, revisions,
      // runtime state and local changes stay exactly as they were.
      const hasEntry = state.entries.some(
        (entry) => entry.packageId === action.package.id,
      );
      return {
        ...state,
        packages,
        entries: hasEntry
          ? state.entries.map((entry) =>
              entry.packageId === action.package.id
                ? {
                    ...entry,
                    slug: action.package.slug,
                    name: action.package.name,
                    version: action.package.version,
                    description: action.package.description ?? "",
                    tags: action.package.tags ?? [],
                  }
                : entry,
            )
          : state.entries,
      };
    }
    case "removed": {
      const removed = new Set([...state.removedIds, ...action.ids]);
      return {
        ...state,
        packages: state.packages.filter((pkg) => !removed.has(pkg.id)),
        entries: state.entries.filter((entry) => !removed.has(entry.packageId)),
        removedIds: removed,
      };
    }
    case "loaded": {
      // The status endpoint lists every room package (including disabled and
      // unpublished ones), so a package the server listed before and no
      // longer lists was deleted elsewhere. A package that never appeared in
      // a status response (created locally, a stale prop) is kept.
      const incomingIds = new Set(action.incoming.map((pkg) => pkg.id));
      const dropped = state.packages
        .filter((pkg) => state.remoteIds.has(pkg.id) && !incomingIds.has(pkg.id))
        .map((pkg) => pkg.id);
      const removedIds =
        dropped.length > 0
          ? new Set([...state.removedIds, ...dropped])
          : state.removedIds;
      const packages = withoutRemoved(
        mergePackages(state.packages, action.incoming, removedIds),
        removedIds,
      );
      return {
        ...state,
        packages,
        entries: buildEntries(
          packages,
          action.remote,
          action.baseline,
          action.snapshots,
          action.present,
        ),
        removedIds,
        remoteIds: incomingIds,
      };
    }
    case "action":
      return {
        ...state,
        actions: {
          ...state.actions,
          [action.packageId]: {
            ...IDLE_ACTION,
            ...state.actions[action.packageId],
            ...action.patch,
          },
        },
      };
    default:
      return state;
  }
}
