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

    Wired().events.addListener("playerConnected", (socketId) => {
      if (!Wired().network.isServer) return;
      this.rpc(this.recievePackages, this.packageManager.getPackages());
    });
  }

  @Rpc("server")
  serverRecievePackage(pack: Package) {
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
    this.rpc(this.serverRecievePackage, pack);
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
    this.rpc(this.execPackage, pack);
  }
  @Rpc("callLocal")
  execPackage(pack: Package) {
    this.packageManager.upsertPackage(pack);
    const packContext = this.packageManager.getPackageById(pack.id);
    if (packContext) {
      packContext.execute();
      console.log("exec");
      this.events.emit("packageExecuted", packContext);
    }
  }
  requestExecPackage(pack: Package) {
    if (Wired().network.isServer) return;
    this.rpc(this.serverExecPackage, pack);
  }
}
