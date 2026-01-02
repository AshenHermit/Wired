import ts from "typescript";

export class ScriptCompiler {
  script: string;
  constructor(script: string) {
    this.script = script;
  }
  compile() {
    let compiled = ts.transpile(this.script, {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      experimentalDecorators: true,
      strictNullChecks: true,
      noImplicitAny: false,
    });

    compiled = `
    (function(exports, require){
      ${compiled}
    });
    `;
    return compiled;
  }
}
