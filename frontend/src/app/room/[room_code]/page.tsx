import { RoomRouteGate } from "./RoomRouteGate";

export default async function Page({
  params,
}: {
  params: Promise<{ room_code: string }>;
}) {
  const { room_code } = await params;
  return <RoomRouteGate roomCode={room_code} />;
}
