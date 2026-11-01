import axios from "axios";
import { ApiClient } from "./api-client";
import { BACKEND_URL } from "@/utils/variables";
import { readAccessToken } from "@/utils/auth-cookie";

function createAxiosClient() {
  const axiosClient = axios.create({
    baseURL: BACKEND_URL,
  });
  axiosClient.interceptors.request.use((config) => {
    if (typeof window !== "undefined") {
      const token = readAccessToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  });
  return axiosClient;
}

export const apiClient = new ApiClient(createAxiosClient());
