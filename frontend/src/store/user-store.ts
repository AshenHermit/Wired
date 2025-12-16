import { getProfile } from "@/api/services/profile";
import { User } from "@/api/services/types";
import { getFallbackPicture } from "@/utils/user-utils";
import { create } from "zustand";

export type LocalUser = User & {
  authorized: boolean;
};

export type UserState = LocalUser & {
  setUser: (state: LocalUser) => void;
  loadUser: () => void;
  loaded: boolean;
};

export const defaultUserObject: LocalUser = {
  id: -1,
  name: "",
  authorized: false,
  email: "",
  picture: "",
  service: "email",
};

export const useUserStore = create<UserState>()((set, get) => ({
  ...defaultUserObject,
  loaded: false,
  setUser: (user: LocalUser) => set((state) => user),
  loadUser: () => {
    getProfile().then((profile) => {
      if (!profile) {
        set((state) => ({ loaded: true, ...defaultUserObject }));
        return;
      }
      get().setUser({
        authorized: true,
        ...profile,
      });
      set((state) => ({ loaded: true }));
    });
  },
}));

export function useLocalUserPicture(): string {
  const picture = useUserStore((state) => state.picture);
  const name = useUserStore((state) => state.name);
  let pic = picture;
  if (!pic) pic = getFallbackPicture(name);
  return pic;
}
