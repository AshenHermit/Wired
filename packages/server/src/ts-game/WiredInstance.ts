import {
  _setupWiredGlobal,
  createWiredGlobal,
  GameScene,
  WiredGlobal,
  WiredInstanceBase,
  WiredInstanceConfig,
} from '@wired-io/shared';
import { ServerGameScene } from './GameScene';

export class WiredInstance extends WiredInstanceBase {
  constructor(config: WiredInstanceConfig) {
    super(config);
  }

  connectPlayer(socketId: string) {
    _setupWiredGlobal(this.wiredGlobal!);
    this.events.emit('playerConnected', socketId);
  }
  disconnectPlayer(socketId: string) {
    _setupWiredGlobal(this.wiredGlobal!);
    this.events.emit('playerDisconnected', socketId);
  }

  setup() {
    this.setupNetwork();
    this.setupGame();
    this.setupWiredGlobal();
  }
  destroy() {
    this.destroyNetwork();
    this.destroyGame();
  }

  setupNetwork(): void {}
  destroyNetwork(): void {}

  setupGame(): void {
    this.scene = new ServerGameScene(this);
    const game = new Phaser.Game({
      type: Phaser.HEADLESS,
      width: 800,
      height: 600,
      parent: '',
      pixelArt: true,
      roundPixels: false,
      autoRound: false,
      antialias: false,
      scene: this.scene,
      zoom: 1,
      backgroundColor: '#000000',
    });
    this.game = game;
  }
  destroyGame(): void {
    if (this.game) this.game.destroy(true);
    this.game = null;
  }
}
