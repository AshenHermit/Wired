import { PackageExecutionContext } from "./PackageExecutionContext";

import * as path from "pathe";
import { ScriptCompiler } from "./ScriptCompiler";
import EventEmitter from "easy-event-emitter";

export interface ScriptExports {
  init?: () => void;
  unload?: () => void;
}

export type ScriptWrapper = (
  exports: Record<string, any> & ScriptExports,
  require: (filepath: string) => any
) => void;

export type ScriptAgentEvents = {
  errorOccured: { script: ScriptAgent; error: Error };
};

export class ScriptAgent {
  filepath: string;
  script: string;
  isMain: boolean;
  scriptContext: PackageExecutionContext;
  events: EventEmitter<ScriptAgentEvents>;
  constructor(
    filepath: string,
    script: string,
    isMain: boolean,
    scriptContext: PackageExecutionContext
  ) {
    this.filepath = filepath;
    this.script = script;
    this.isMain = isMain;
    this.scriptContext = scriptContext;
    this.events = new EventEmitter<ScriptAgentEvents>();
    this.events.addListener("errorOccured", (event) => {
      this.scriptContext.events.emit("errorOccured", event);
    });
  }
  exec() {
    const exports: ScriptExports = {};
    const compiler = new ScriptCompiler(this.script);
    try {
      const func = eval(compiler.compile()) as ScriptWrapper;
      func(exports, this.require.bind(this));
      return exports;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.events.emit("errorOccured", { script: this, error });
      throw e;
    }
  }
  require(filepath: string) {
    if (filepath.startsWith(".")) {
      const origPath = path.resolve(path.dirname(this.filepath), filepath);
      return this.scriptContext.requireScript(origPath);
    }
    return this.scriptContext.requireScript(filepath);
  }
}
