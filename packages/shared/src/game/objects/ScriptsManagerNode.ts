import { ScriptingPackage } from "../../api/types";
import EventEmitter from "easy-event-emitter";
import {
  PackageExecutionContext,
  PackageManagerContext,
} from "../../scripting";
import { RegisteredNode } from "../NodesRegistry";
import { Wired } from "../WiredGlobal";
import { Node, Rpc } from "./Node";

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

    const isServer = Wired().network.isServer;
    Wired().events.addListener("playerConnected", async (socketId) => {
      if (!isServer) return;
      const packs = this.packageManager.getPackages();
      await this.rpcId(this.recieveAndExecAllPackages, socketId, packs);
      Wired().events.emit("playerScriptsReady", socketId);
    });
    this.packageManager.events.addListener("packageUpserted", (pack) => {
      if (isServer) {
        this.rpc(this.recievePackages, [pack.getPackage()]);
      }
    });
    this.packageManager.events.addListener("packageRemoved", (id) => {
      if (isServer) {
        this.rpc(this.removePackage, id);
      }
    });
  }

  @Rpc("server")
  serverRecieveAddPackage(pack: ScriptingPackage) {
    this.packageManager.upsertPackage(pack);
    this.rpc(this.recievePackages, [pack]);
  }
  @Rpc("client")
  recievePackages(packages: ScriptingPackage[]) {
    for (const pack of packages) {
      this.packageManager.upsertPackage(pack);
    }
  }
  requestAddPackage(pack: ScriptingPackage) {
    if (Wired().network.isServer) return;
    this.rpc(this.serverRecieveAddPackage, pack);
  }

  @Rpc("server")
  serverRemovePackage(pack: ScriptingPackage) {
    this.callRpc(this.removePackage, pack.id);
    this.rpc(this.removePackage, pack.id);
  }
  @Rpc("client")
  removePackage(id: number) {
    const packContext = this.packageManager.getPackageById(id);
    if (packContext) {
      if (packContext.lastExports) {
        if (packContext.lastExports.unload) packContext.lastExports.unload();
      }
    }
    this.packageManager.removePackage(id);
  }
  requestRemovePackage(pack: ScriptingPackage) {
    if (Wired().network.isServer) return;
    this.rpc(this.serverRemovePackage, pack);
  }

  @Rpc("server")
  serverExecPackage(pack: ScriptingPackage) {
    this.rpc(this.recieveExecPackage, pack);
    this.execPackage(pack);
  }
  @Rpc("client")
  recieveExecPackage(pack: ScriptingPackage) {
    this.execPackage(pack);
  }
  @Rpc("client")
  recieveAndExecAllPackages(packages: ScriptingPackage[]) {
    for (const pack of packages) {
      this.packageManager.upsertPackage(pack);
    }
    this.execAllPackages();
    return true;
  }

  execAllPackages() {
    for (const pack of this.packageManager.getPackages()) {
      this.execPackage(pack);
    }
  }

  execPackage(pack: ScriptingPackage) {
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

  requestExecPackage(pack: ScriptingPackage) {
    if (Wired().network.isServer) return;
    this.rpc(this.serverExecPackage, pack);
  }
}
