import * as Phaser from "phaser";
import { Wired } from "../WiredGlobal";
import { Node, Rpc } from "./Node";
import { RegisteredNode } from "../NodesRegistry";
import EventEmitter from "easy-event-emitter";


export type NetworkMetricsState = {
  ping: number;
  timeToSend: number;
  timeToReceive: number;
};

export type NetworkMetricsEvents = {
  recievedState: NetworkMetricsState
}

@RegisteredNode("NetworkMetricsNode")
export class NetworkMetricsNode extends Node<NetworkMetricsState>
{
  timer = 0.1;
  timerTimeout = 1 * 1000;
  metricsEvents = new EventEmitter<NetworkMetricsEvents>();

  stateHistory: Array<NetworkMetricsState> = [];

  constructor() {
    super();
  }
  update(time: number, delta: number): void {
    super.update(time, delta);
    if(!Wired().network.isServer){
      if (this.timer > 0) {
        this.timer -= delta;
      } else {
        this.timer = this.timerTimeout;
        this.sendPackage();
      }
    }
  }

  sendPackage(){
    this.rpc(this.serverSendPackageBack, Date.now());
  }

  @Rpc("server")
  serverSendPackageBack(startTime: number){
    const endTime = Date.now();
    const timeToSend = endTime - startTime;
    this.rpcId(this.recievePackage, Wired().network.lastRecievedSocketId, startTime, timeToSend);
  }

  @Rpc("client")
  recievePackage(startTime: number, timeToSend: number){
    const endTime = Date.now();
    const timeToReceive = endTime - startTime;
    this.setNodeState({ping: endTime - startTime, timeToSend, timeToReceive});
    this.metricsEvents.emit("recievedState", this.getNodeState())
  }
}
