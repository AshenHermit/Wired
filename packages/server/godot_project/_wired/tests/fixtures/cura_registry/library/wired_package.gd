extends "res://tests/fixtures/cura_registry/library_entry.gd"

## `PackageEntryLoader` ищет entry только по имени `wired_package.gd`, а корень
## фикстур `cura_registry` уже занят entry стороннего пакета из
## `crate_prop_example`. Этот файл делает entry библиотеки видимым загрузчику,
## не дублируя код регистрации из `library_entry.gd`.
