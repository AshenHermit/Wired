"use client";

import { LiquidButton } from "@/components/animate-ui/components/buttons/liquid";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { PlayIcon } from "lucide-react";

export function RoomCard() {
  return (
    <Card className="min-h-32">
      <CardHeader>
        <CardTitle>Room 1</CardTitle>
      </CardHeader>
      <CardFooter>
        <LiquidButton>
          <PlayIcon />
        </LiquidButton>
      </CardFooter>
    </Card>
  );
}

export function RoomsList() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <RoomCard />
      <RoomCard />
      <RoomCard />
      <RoomCard />
      <RoomCard />
      <RoomCard />
      <RoomCard />
      <RoomCard />
    </div>
  );
}
