import { RoomPageClientNoSSR } from "./RoomPageClient";

export default async function Page({
  params,
}: {
  params: Promise<{ room_code: string }>;
}) {
  const { room_code } = await params;
  return <RoomPageClientNoSSR roomCode={room_code} />;
}
