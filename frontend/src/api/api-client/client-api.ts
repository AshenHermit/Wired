import axios from "axios";
import { ApiClient } from "./api-client";
import { BACKEND_URL } from "@/utils/variables";

function createAxiosClient() {
  const axiosClient = axios.create({
    baseURL: BACKEND_URL,
  });
  axiosClient.interceptors.request.use((config) => {
    if (typeof window !== "undefined") {
      const match = document.cookie.match(/(?:^|; )access_token=([^;]*)/);
      if (match) {
        config.headers.Authorization = `Bearer ${match[1]}`;
      }
    }
    return config;
  });
  return axiosClient;
}

export const apiClient = new ApiClient(createAxiosClient());
