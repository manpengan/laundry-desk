import { createHashRouter, RouterProvider, Navigate } from "react-router-dom";
import Home from "./Home";
import Receive from "./Receive";
import Pickup from "./Pickup";
import Orders from "./Orders";
import OrderDetail from "./OrderDetail";
import Layout from "../components/Layout";
import Customers from "./Customers";
import Stats from "./Stats";
import Settings from "./Settings";

const router = createHashRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        element: <Home />,
      },
      {
        path: "receive",
        element: <Receive />,
      },
      {
        path: "pickup",
        element: <Pickup />,
      },
      {
        path: "orders",
        element: <Orders />,
      },
      {
        path: "orders/:id",
        element: <OrderDetail />,
      },
      {
        path: "customers",
        element: <Customers />,
      },
      {
        path: "stats",
        element: <Stats />,
      },
      {
        path: "settings",
        element: <Settings />,
      },
      {
        path: "*",
        element: <Navigate to="/" replace />,
      },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
