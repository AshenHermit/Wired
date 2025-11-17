import EventEmitter from "easy-event-emitter";
import {
  PackageExecutionContext,
  PackageManagerContext,
  type Package,
} from "../../scripting";
import { RegisteredNode } from "../NodesRegistry";
import { Wired } from "../WiredGlobal";
import { Node, Rpc } from "./Node";
import { v4 as uuidv4 } from "uuid";

export type ScriptsManagerEvents = {
  packageExecuted: PackageExecutionContext;
};

@RegisteredNode("ScriptsManagerNode")
export class ScriptsManagerNode extends Node {
  packageManager: PackageManagerContext;
  events: EventEmitter<ScriptsManagerEvents>;
  constructor() {
    super();
    this.packageManager = new PackageManagerContext();
    this.events = new EventEmitter<ScriptsManagerEvents>();

    Wired().events.addListener("playerConnected", async (socketId) => {
      if (!Wired().network.isServer) return;
      const packs = this.packageManager.getPackages();
      await this.rpcId(this.recieveAndExecAllPackages, socketId, packs);
      Wired().events.emit("playerScriptsReady", socketId);
    });
  }

  @Rpc("server")
  serverRecieveAddPackage(pack: Package) {
    pack.id = uuidv4();
    this.packageManager.upsertPackage(pack);
    this.rpc(this.recievePackages, [pack]);
  }
  @Rpc("client")
  recievePackages(packages: Package[]) {
    for (const pack of packages) {
      this.packageManager.upsertPackage(pack);
    }
  }
  requestAddPackage(pack: Package) {
    if (Wired().network.isServer) return;
    this.rpc(this.serverRecieveAddPackage, pack);
  }

  @Rpc("server")
  serverRemovePackage(pack: Package) {
    this.packageManager.removePackage(pack.id);
    this.rpc(this.removePackage, pack.id);
  }
  @Rpc("client")
  removePackage(id: string) {
    this.packageManager.removePackage(id);
  }
  requestRemovePackage(pack: Package) {
    if (Wired().network.isServer) return;
    this.rpc(this.serverRemovePackage, pack);
  }

  @Rpc("server")
  serverExecPackage(pack: Package) {
    this.rpc(this.recieveExecPackage, pack);
    this.execPackage(pack);
  }
  @Rpc("client")
  recieveExecPackage(pack: Package) {
    this.execPackage(pack);
  }
  @Rpc("client")
  recieveAndExecAllPackages(packages: Package[]) {
    for (const pack of packages) {
      this.packageManager.upsertPackage(pack);
    }
    for (const pack of this.packageManager.getPackages()) {
      this.execPackage(pack);
    }
    return true;
  }

  execPackage(pack: Package) {
    this.packageManager.upsertPackage(pack);
    const packContext = this.packageManager.getPackageById(pack.id);
    if (packContext) {
      if (packContext.lastExports) {
        if (packContext.lastExports.unload) packContext.lastExports.unload();
      }
      const exports = packContext.execute();
      if (exports) {
        if (exports.init) exports.init();
      }
      this.events.emit("packageExecuted", packContext);
    }
  }

  requestExecPackage(pack: Package) {
    if (Wired().network.isServer) return;
    this.rpc(this.serverExecPackage, pack);
  }
}
