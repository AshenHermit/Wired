"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { LoginForm } from "../_components/LoginForm";
import { useUserStore } from "@/store/user-store";
import {
  Card,
  CardContent,
  CardDescription,
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
import { RoomsList } from "../_components/rooms/RoomsList";
import { CurrentUserEditingButton } from "../_components/UserEditing";
import { WorkshopBrowser } from "@/components/packages/WorkshopBrowser";

export function HomepageClient() {
  const user = useUserStore((state) => state);
  const t = useTranslations("Home");

  return (
    <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-stretch py-32 px-16">
      <img
        src={"/logo_splash.png"}
        alt="logo"
        className="render-pixelated object-contain w-lg"
      />
      <div className="flex flex-col gap-6 items-center w-full">
        {user.authorized ? <ClientPanel /> : <LoginForm />}
        <Tabs defaultValue="rooms" className="w-full">
          <TabsList>
            <TabsTrigger value="rooms">{t("tabs.rooms")}</TabsTrigger>
            <TabsTrigger value="controls">{t("tabs.controls")}</TabsTrigger>
            <TabsTrigger value="packages">{t("tabs.packages")}</TabsTrigger>
            <TabsTrigger value="docs">{t("tabs.docs")}</TabsTrigger>
          </TabsList>
          <Card className="shadow-none py-0 w-full">
            <TabsContents className="py-6 w-full">
              <TabsContent value="rooms" className="flex flex-col gap-6 w-full">
                <CardHeader>
                  <CardTitle>{t("rooms.title")}</CardTitle>
                  <CardDescription>{t("rooms.description")}</CardDescription>
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
                  <CardTitle>{t("controls.title")}</CardTitle>
                  <CardDescription>{t("controls.description")}</CardDescription>
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
                  <CardTitle>{t("packages.title")}</CardTitle>
                  <CardDescription>{t("packages.description")}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-6">
                  <WorkshopBrowser />
                </CardContent>
              </TabsContent>
              <TabsContent value="docs" className="flex flex-col gap-6 w-full">
                <CardHeader>
                  <CardTitle>{t("docs.title")}</CardTitle>
                  <CardDescription>{t("docs.description")}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <Link
                      href="/docs?doc=getting-started"
                      className="p-4 rounded border border-foreground/10 hover:bg-foreground/5 transition"
                    >
                      <div className="font-semibold">
                        {t("docs.nav.gettingStarted")}
                      </div>
                    </Link>
                    <Link
                      href="/docs?doc=api-reference"
                      className="p-4 rounded border border-foreground/10 hover:bg-foreground/5 transition"
                    >
                      <div className="font-semibold">
                        {t("docs.nav.apiReference")}
                      </div>
                    </Link>
                    <Link
                      href="/docs?doc=entity-registration"
                      className="p-4 rounded border border-foreground/10 hover:bg-foreground/5 transition"
                    >
                      <div className="font-semibold">
                        {t("docs.nav.entityRegistration")}
                      </div>
                    </Link>
                    <Link
                      href="/docs?doc=multiplayer-guide"
                      className="p-4 rounded border border-foreground/10 hover:bg-foreground/5 transition"
                    >
                      <div className="font-semibold">
                        {t("docs.nav.multiplayerGuide")}
                      </div>
                    </Link>
                  </div>
                  <div>
                    {t("docs.issues.description")}{" "}
                    <a
                      href="https://github.com/AshenHermit/Wired/issues/new"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline text-[#ff617b]"
                    >
                      {t("docs.issues.link")}
                    </a>
                  </div>
                </CardContent>
              </TabsContent>
            </TabsContents>
          </Card>
        </Tabs>
      </div>
    </main>
  );
}

export function ClientPanel() {
  const user = useUserStore((state) => state);
  const t = useTranslations("Home");
  if (!user.authorized) return null;

  return (
    <Card className="min-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>{t("greeting", { name: user.name })}</span>
          <CurrentUserEditingButton />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div>{t("intro")}</div>
        <div className="text-[10px]">{t("small")}</div>
        <br />
        <div>
          {t.rich("warning", {
            code: (chunks) => <span className="text-blue-300">{chunks}</span>,
          })}
        </div>
      </CardContent>
    </Card>
  );
}
