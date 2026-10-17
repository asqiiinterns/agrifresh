import type { Product } from "../types/product";

export const products: Product[] = [
  {
    id: "jus-orange",
    name: "Jus d’orange pressé",
    description: "100 % oranges, frais et ensoleillé",
    category: "Jus frais",
    price: 8.5,
    unit: "bouteille · 1 L",
    image: "https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=900&q=85",
    badge: "Favori",
    available: true
  },
  {
    id: "jus-fraise",
    name: "Jus fraise & pomme",
    description: "Une recette douce et fruitée",
    category: "Jus frais",
    price: 9.9,
    unit: "bouteille · 1 L",
    image: "https://images.unsplash.com/photo-1622597467836-f3285f2131b8?auto=format&fit=crop&w=900&q=85",
    badge: "À découvrir",
    available: true
  },
  {
    id: "oranges",
    name: "Oranges de saison",
    description: "Juteuses, sélectionnées avec soin",
    category: "Fruits",
    price: 4.2,
    unit: "kg",
    image: "https://images.unsplash.com/photo-1547514701-42782101795e?auto=format&fit=crop&w=900&q=85",
    available: true
  },
  {
    id: "tomates",
    name: "Tomates du marché",
    description: "Pour des salades pleines de goût",
    category: "Légumes",
    price: 3.4,
    unit: "kg",
    image: "https://images.unsplash.com/photo-1546094096-0df4bcaaa337?auto=format&fit=crop&w=900&q=85",
    available: true
  },
  {
    id: "dattes",
    name: "Dattes Deglet Nour",
    description: "Une douceur naturellement généreuse",
    category: "Épicerie",
    price: 14.5,
    unit: "boîte · 500 g",
    image: "https://images.unsplash.com/photo-1590080877777-b7d7c4d1e9a4?auto=format&fit=crop&w=900&q=85",
    badge: "Terroir",
    available: true
  },
  {
    id: "citron",
    name: "Citrons frais",
    description: "Parfaits pour vos boissons maison",
    category: "Fruits",
    price: 3.8,
    unit: "kg",
    image: "https://images.unsplash.com/photo-1513558161293-cdaf765edfd7?auto=format&fit=crop&w=900&q=85",
    available: true
  }
];