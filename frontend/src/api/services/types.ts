export type TypeFile = {
  filepath: string;
  content: string;
};

export type User = {
  id: number;
  email: string;
  name: string;
  service: "email" | "google" | "vk" | "yandex" | "github";
  picture: string;
};
