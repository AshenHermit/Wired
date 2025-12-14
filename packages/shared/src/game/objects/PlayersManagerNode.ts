import { getNodeCtor, RegisteredNode } from "../NodesRegistry";
import { Wired } from "../WiredGlobal";
import { asNode, Node, Rpc } from "./Node";
import { PlayerBaseInterface } from "./PlayerBase";
import { TestPlayer } from "./TestPlayer";

@RegisteredNode("PlayersManagerNode")
export class PlayersManagerNode extends Node {
  players: PlayerBaseInterface[] = [];
  playerClass = "TestPlayer";

  constructor() {
    super();

    Wired().events.addListener("playerScriptsReady", (socketId) => {
      if (!Wired().network.isServer) return;
      const newPlayerClass = getNodeCtor(this.playerClass);
      if (newPlayerClass) {
        const player = new newPlayerClass();
        player.setNodeState({ socketId });
        player.setName(`player-${socketId}`);
        this.players.push(player as PlayerBaseInterface);
        this.add(player);
        this.broadcast();
      }
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

  async serverRecreatePlayers() {
    if (!Wired().network.isServer) return;
    const newPlayerClass = getNodeCtor(this.playerClass);
    if (newPlayerClass) {
      // this.players = [];
      const newPlayers: PlayerBaseInterface[] = [];
      for (const player of this.getAll()) {
        const node = asNode(player);
        if (node) {
          const newNode = await node.serverRecreateNode(this.playerClass);
          if (newNode) {
            newPlayers.push(newNode as PlayerBaseInterface);
          }
        }
      }
      this.players = newPlayers;
    }
  }

  registerPlayerClass(playerClass: string) {
    this.playerClass = playerClass;
    this.serverRecreatePlayers();
  }
}
