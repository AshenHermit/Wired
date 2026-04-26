import { ProjectInfo, User } from "@wired-io/shared";
import { apiClient } from "../api-client/client-api";

export async function getGodotProjectInfo() {
  const info = await apiClient.get<ProjectInfo, void>(
    "godot-project-info/wired"
  );
  info.baseUrl = "/api" + info.baseUrl;
  return info;
}
