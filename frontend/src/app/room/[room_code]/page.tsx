import { RoomPageClient } from "./page-client";

export default async function Page({
  params,
}: {
  params: Promise<{ room_code: string }>;
}) {
  const { room_code } = await params;
  return <RoomPageClient roomCode={room_code} />;
}
