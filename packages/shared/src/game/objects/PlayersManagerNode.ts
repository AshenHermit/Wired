import { RegisteredNode } from "../NodesRegistry";
import { Wired } from "../WiredGlobal";
import { Node, Rpc } from "./Node";
import { Player } from "./Player";

@RegisteredNode("PlayersManagerNode")
export class PlayersManagerNode extends Node {
  players: Player[] = [];

  constructor() {
    super();

    Wired().events.addListener("playerConnected", (socketId) => {
      if (!Wired().network.isServer) return;
      const player = new Player();
      player.setupNodeState({ socketId });
      this.players.push(player);
      this.add(player);
      this.broadcast();
    });
    Wired().events.addListener("playerDisconnected", (socketId) => {
      if (!Wired().network.isServer) return;
      const player = this.players.find(
        (p) => p.getNodeState().socketId === socketId
      );
      if (player) {
        this.players = this.players.filter((p) => p !== player);
        player.broadcastDestroy();
      }
    });
  }
}
