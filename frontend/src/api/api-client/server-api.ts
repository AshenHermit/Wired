import axios from "axios";
import { ApiClient } from "./api-client";
import { BACKEND_URL } from "@/utils/variables";

function createAxiosClient() {
  const axiosClient = axios.create({
    baseURL: BACKEND_URL,
  });
  return axiosClient;
}

export const apiClient = new ApiClient(createAxiosClient());
