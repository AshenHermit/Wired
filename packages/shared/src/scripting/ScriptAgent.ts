import { PackageExecutionContext } from "./PackageExecutionContext";

import * as path from "pathe";
import { ScriptCompiler } from "./ScriptCompiler";

export interface ScriptExports {
  init?: () => void;
  unload?: () => void;
}

export type ScriptWrapper = (
  exports: Record<string, any> & ScriptExports,
  require: (filepath: string) => any
) => void;

export class ScriptAgent {
  filepath: string;
  script: string;
  isMain: boolean;
  scriptContext: PackageExecutionContext;

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
  }
  exec() {
    const exports: ScriptExports = {};
    const compiler = new ScriptCompiler(this.script);
    const func = eval(compiler.compile()) as ScriptWrapper;
    func(exports, this.require.bind(this));
    return exports;
  }
  require(filepath: string) {
    if (filepath.startsWith(".")) {
      const origPath = path.resolve(path.dirname(this.filepath), filepath);
      return this.scriptContext.requireScript(origPath);
    }
    return this.scriptContext.requireScript(filepath);
  }
}
