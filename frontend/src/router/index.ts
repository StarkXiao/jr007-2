import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

// 路由守卫只负责体验，真正的权限边界始终在服务端。
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "map", component: () => import("@/pages/MapPage.vue") },
    {
      path: "/spots/new",
      name: "spot-new",
      component: () => import("@/pages/SpotEditPage.vue"),
      meta: { requiresAuth: true },
    },
    { path: "/spots/:uuid", name: "spot-detail", component: () => import("@/pages/SpotDetailPage.vue") },
    {
      path: "/spots/:uuid/edit",
      name: "spot-edit",
      component: () => import("@/pages/SpotEditPage.vue"),
      meta: { requiresAuth: true },
    },
    { path: "/login", name: "login", component: () => import("@/pages/LoginPage.vue"), meta: { guestOnly: true } },
    {
      path: "/register",
      name: "register",
      component: () => import("@/pages/RegisterPage.vue"),
      meta: { guestOnly: true },
    },
    { path: "/me", name: "me", component: () => import("@/pages/MePage.vue"), meta: { requiresAuth: true } },
    {
      path: "/me/notifications",
      name: "notifications",
      component: () => import("@/pages/NotificationsPage.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/review",
      name: "review-queue",
      component: () => import("@/pages/ReviewQueuePage.vue"),
      meta: { requiresRole: "moderator" },
    },
    {
      path: "/review/:id",
      name: "review-detail",
      component: () => import("@/pages/ReviewDetailPage.vue"),
      meta: { requiresRole: "moderator" },
    },
    {
      path: "/privacy",
      name: "privacy-queue",
      component: () => import("@/pages/PrivacyQueuePage.vue"),
      meta: { requiresRole: "moderator" },
    },
    {
      path: "/reports",
      name: "reports",
      component: () => import("@/pages/ReportsPage.vue"),
      meta: { requiresRole: "moderator" },
    },
    {
      path: "/admin",
      name: "admin",
      component: () => import("@/pages/AdminPage.vue"),
      meta: { requiresRole: "admin" },
    },
    { path: "/:pathMatch(.*)*", name: "not-found", component: () => import("@/pages/NotFoundPage.vue") },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  if (!auth.ready) {
    await auth.bootstrap();
  }

  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: "login", query: { redirect: to.fullPath } };
  }

  if (to.meta.requiresRole === "moderator" && !auth.isModerator) {
    return { name: "map" };
  }

  if (to.meta.requiresRole === "admin" && !auth.isAdmin) {
    return { name: "map" };
  }

  if (to.meta.guestOnly && auth.isLoggedIn) {
    return { name: "map" };
  }

  return true;
});

export default router;
