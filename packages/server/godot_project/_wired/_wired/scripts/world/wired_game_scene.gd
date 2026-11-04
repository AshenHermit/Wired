extends Node
class_name WiredGameScene

## Корень `Main/Game`: сцена пакета или штатный `Game`.
##
## `world_viewport` — единственный контракт с ядром: в него переносятся
## StaticWorld, DynamicWorld и Players. Остальные SubViewport сцены свободны
## (миникарта, превью, UI-эффекты).
@export var world_viewport: SubViewport
