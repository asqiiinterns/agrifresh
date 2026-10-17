import type { Product } from "./product";

export type CartLine = {
  product: Product;
  quantity: number;
};
