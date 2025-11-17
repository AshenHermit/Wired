"use client";

import dynamic from "next/dynamic";

export const RoomPageClientNoSSR = dynamic(
  async () => (await import("./RoomPageClient")).RoomPageClient,
  {
    ssr: false,
  }
);
