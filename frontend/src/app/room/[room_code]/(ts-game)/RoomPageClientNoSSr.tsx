"use client";

import dynamic from "next/dynamic";

export const TSRoomPageClientNoSSR = dynamic(
  async () => (await import("./RoomPageClient")).RoomPageClient,
  {
    ssr: false,
  }
);
