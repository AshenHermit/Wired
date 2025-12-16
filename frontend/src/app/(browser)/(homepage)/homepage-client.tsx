"use client";

import { Button } from "@/components/ui/button";
import Image from "next/image";
import Link from "next/link";
import { LoginForm } from "../login/login-form";
import { useUserStore } from "@/store/user-store";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from "@/components/animate-ui/components/animate/tabs";
import { RoomsList } from "../_components/rooms";
import { CurrentUserEditingButton } from "../_components/user";

export function HomepageClient() {
  const user = useUserStore((state) => state);

  return (
    <div className="flex flex-col gap-6 items-center w-full">
      {user.authorized ? <ClientPanel /> : <LoginForm />}
      <Tabs defaultValue="rooms" className="w-full">
        <TabsList>
          <TabsTrigger value="rooms">Комнаты</TabsTrigger>
          <TabsTrigger value="controls">Управление</TabsTrigger>
          <TabsTrigger value="packages">Пакеты</TabsTrigger>
          <TabsTrigger value="docs">Документация</TabsTrigger>
        </TabsList>
        <Card className="shadow-none py-0 w-full">
          <TabsContents className="py-6 w-full">
            <TabsContent value="rooms" className="flex flex-col gap-6 w-full">
              <CardHeader>
                <CardTitle>Комнаты</CardTitle>
                <CardDescription>Присоединяйтесь!</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-6">
                <RoomsList forCurrentUser={false} />
              </CardContent>
            </TabsContent>
            <TabsContent
              value="controls"
              className="flex flex-col gap-6 w-full"
            >
              <CardHeader>
                <CardTitle>Управление</CardTitle>
                <CardDescription>
                  Здесь можно создавать и управлять комнатами
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-6">
                <RoomsList forCurrentUser={true} />
              </CardContent>
            </TabsContent>
            <TabsContent
              value="packages"
              className="flex flex-col gap-6 w-full"
            >
              <CardHeader>
                <CardTitle>Пакеты</CardTitle>
                <CardDescription>
                  Здесь будут храниться пакеты скриптов
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-6"></CardContent>
            </TabsContent>
            <TabsContent value="docs" className="flex flex-col gap-6 w-full">
              <CardHeader>
                <CardTitle>Документация</CardTitle>
                <CardDescription>
                  Здесь будет собрано основное api wired-io для разработки
                  скриптов, чтобы не смотреть постоянно в исходники
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-6"></CardContent>
            </TabsContent>
          </TabsContents>
        </Card>
      </Tabs>
      <Link href="/room/1">
        <Button>Join Room 1</Button>
      </Link>
    </div>
  );
}

export function ClientPanel() {
  const user = useUserStore((state) => state);
  if (!user.authorized) return null;

  return (
    <Card className="min-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>
            {">"} Привет, {user.name}!
          </span>
          <CurrentUserEditingButton />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div>
          wired io еще не такой уж классный как хотелось бы, но автор че то
          пытается, делает
        </div>
        <div className="text-[10px]">
          надеюсь голова не закружится от параллакса
        </div>
      </CardContent>
    </Card>
  );
}
