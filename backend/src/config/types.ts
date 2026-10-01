export type AppEnv = "local" | "development" | "production";

export interface AppConfig {
  env: AppEnv;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  aws: {
    region: string;
  };
  dynamodb: {
    tableName: string;
    endpoint?: string;
  };
}
