import { MongoClient } from "mongodb";

export function createMongoClient(uri: string): MongoClient {
  return new MongoClient(uri);
}
