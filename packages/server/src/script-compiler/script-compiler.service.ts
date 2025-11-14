import { Get, Injectable, OnModuleInit } from '@nestjs/common';
import { ScriptCompiler } from '@wired-io/shared';

@Injectable()
export class ScriptCompilerService implements OnModuleInit {
  constructor() {}

  onModuleInit() {
    this.compile()
      .then((x) => console.log(`SCRIPT: ${x}`))
      .catch((err) => console.error(err));
  }

  async compile() {
    const script = `import { Node, RegisteredNode } from '@wired-io/shared';
    @RegisteredNode('MyNode')
    export class MyNode extends Node{
      constructor(){
          super();
      }
    }
    export function onModuleInit(){
      redefinePlayer(MyNode);
    }
    `;
    const compiler = new ScriptCompiler(script);
    const compiled = compiler.compile();
    return compiled;
  }
}
