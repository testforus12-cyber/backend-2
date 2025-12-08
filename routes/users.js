// routes/users.js
import express from "express";
const router = express.Router();

// Dev route: GET /api/users/me
router.get("/me", (_req, res) => {
  res.json({
    _id: "user_123",
    firstName: "Uttam",
    lastName: "Goyal",
    name: "Uttam Goyal",
    email: "forus@gmail.com",
    phone: 6548974646,
    companyName: "Forus Electric",
    gstNumber: "FEWBFIE2HFBEO",
    address: "B313 Okhla Phase 1",
    city: "Delhi",
    state: "Delhi",
    pincode: 110020,
    pickupAddresses: [],
    preferredVendors: [],
    // createdAt as ISO string
    createdAt: "2025-07-03T09:13:39.689Z"
  });
});

export default router;
