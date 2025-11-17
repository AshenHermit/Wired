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
  wiredGlobal: WiredGlobal;
  destroyed = false;
  private displayElement: HTMLElement | null = null;
  private onBlurHandler: (() => void) | null = null;
  private onFocusHandler: (() => void) | null = null;
  constructor(config: WiredInstanceConfig) {
    super(config);
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
        const localId = await this.network.connectToRoom(1);
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
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      width: 800,
      height: 600,
      parent: this.config.displayParent,
      scene: [TestGameScene],
      backgroundColor: "#000000",
    });
    this.game = game;

    // Находим DOM элемент по id
    this.displayElement = game.canvas;
    if (this.displayElement) {
      // Добавляем обработчики
      window.addEventListener("click", (e) => {
        if (this.game && !this.destroyed) {
          if (e.target == this.game.canvas) {
            this.game.input.keyboard.enabled = true;
          } else {
            this.game.input.keyboard.enabled = false;
          }
        }
      });

      // Изначально отключаем ввод
      game.input.keyboard.enabled = false;
    } else {
      // Если элемент не найден, используем стандартное поведение Phaser
      game.input.keyboard.enabled = false;
      game.events.on(Phaser.Core.Events.BLUR, () => {
        game.input.keyboard.enabled = false;
      });
      game.events.on(Phaser.Core.Events.FOCUS, () => {
        game.input.keyboard.enabled = true;
      });
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
