import {
  _setupWiredGlobal,
  createWiredGlobal,
  GameScene,
  TestGameScene,
  WiredGlobal,
  WiredInstanceBase,
  WiredInstanceConfig,
} from "@wired-io/shared";

export class WiredInstance extends WiredInstanceBase {
  wiredGlobal?: WiredGlobal;
  destroyed = false;
  private displayElement: HTMLElement | null = null;
  private onBlurHandler: (() => void) | null = null;
  private onFocusHandler: (() => void) | null = null;
  public roomId: number;
  public scene!: GameScene;

  constructor(config: WiredInstanceConfig, roomId: number) {
    super(config);
    this.roomId = roomId;
  }

  setup() {
    this.destroyed = false;
    this.setupNetwork();
  }
  destroy() {
    this.destroyNetwork();
    this.destroyGame();
    this.destroyed = true;
  }

  setupNetwork(): void {
    this.network.connect();
    this.network.events.addListener("connected", async () => {
      if (this.destroyed) return;
      this.setupGame();
      this.setupWiredGlobal();
      const interval = 0;
      this.events.addListener("sceneReady", async () => {
        const localId = await this.network.connectToRoom(this.roomId);
        this.network.localId = localId;
        this.events.emit("stateChanged", "connected");
      });
    });
    this.network.events.addListener("disconnected", () => {
      this.destroyGame();
      this.events.emit("stateChanged", "disconnected");
    });
  }
  destroyNetwork(): void {
    this.network.disconnect();
  }

  setupGame(): void {
    this.scene = new TestGameScene(this);
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      width: 800,
      height: 600,
      parent: this.config.displayParent,
      scene: this.scene,
      pixelArt: true,
      roundPixels: false,
      autoRound: false,
      antialias: false,
      zoom: 1,
      backgroundColor: "#000000",
    });
    this.game = game;

    // Находим DOM элемент по id
    this.displayElement = game.canvas;
    const keyboard = game.input.keyboard;
    if (game && keyboard) {
      if (this.displayElement) {
        // Добавляем обработчики
        window.addEventListener("click", (e) => {
          if (e.target == game.canvas) {
            keyboard.enabled = true;
          } else {
            keyboard.enabled = false;
          }
        });

        // Изначально отключаем ввод
        keyboard.enabled = false;
      } else {
        // Если элемент не найден, используем стандартное поведение Phaser
        keyboard.enabled = false;
        game.events.on(Phaser.Core.Events.BLUR, () => {
          if (keyboard) {
            keyboard.enabled = false;
          }
        });
        game.events.on(Phaser.Core.Events.FOCUS, () => {
          if (keyboard) {
            keyboard.enabled = true;
          }
        });
      }
    }
  }
  destroyGame(): void {
    // Удаляем обработчики событий с DOM элемента
    if (this.displayElement && this.onBlurHandler && this.onFocusHandler) {
      this.displayElement.removeEventListener("blur", this.onBlurHandler);
      this.displayElement.removeEventListener("focus", this.onFocusHandler);
    }

    this.displayElement = null;
    this.onBlurHandler = null;
    this.onFocusHandler = null;

    if (this.game) this.game.destroy(true);
    this.game = null;
  }
}
