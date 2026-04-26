const express = require("express");
const cors = require("cors");
const pool = require("./db");

const app = express();

app.use(cors());
app.use(express.json());

function getSqlError(error) {
  return error.sqlMessage || error.message || "Database error";
}

// 1. Test database connection
app.get("/api/test", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: getSqlError(error) });
  }
});

// 2. Get admin list for dropdown
app.get("/api/admins", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        a.StaffID,
        u.Full_name,
        a.Admin_level
      FROM ADMIN a
      JOIN USER u ON u.UserID = a.StaffID
      ORDER BY a.StaffID
    `);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: getSqlError(error) });
  }
});

// 3. Discount usage report
app.get("/api/discount-usage-report", async (req, res) => {
  try {
    const adminId = req.query.adminId || null;
    const onlyActive = req.query.onlyActive === "true";
    const minBookings = Number(req.query.minBookings || 0);
    const minRevenue = Number(req.query.minRevenue || 0);

    const [rows] = await pool.query(
      "CALL sp_discount_usage_report(?, ?, ?, ?)",
      [adminId, onlyActive, minBookings, minRevenue]
    );

    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: getSqlError(error) });
  }
});

// 4. Create discount
app.post("/api/discounts", async (req, res) => {
  try {
    const { discountCode, name, discountValue, expiryDate, adminId } = req.body;

    await pool.query("CALL sp_insert_discount(?, ?, ?, ?, ?)", [
      discountCode,
      name,
      discountValue,
      expiryDate,
      adminId,
    ]);

    res.json({ message: "Discount created successfully." });
  } catch (error) {
    res.status(400).json({ message: getSqlError(error) });
  }
});

// 5. Update discount
app.put("/api/discounts/:code", async (req, res) => {
  try {
    const discountCode = req.params.code;
    const { name, discountValue, expiryDate, adminId } = req.body;

    await pool.query("CALL sp_update_discount(?, ?, ?, ?, ?)", [
      discountCode,
      name,
      discountValue,
      expiryDate,
      adminId,
    ]);

    res.json({ message: "Discount updated successfully." });
  } catch (error) {
    res.status(400).json({ message: getSqlError(error) });
  }
});

// 6. Delete discount
app.delete("/api/discounts/:code", async (req, res) => {
  try {
    const discountCode = req.params.code;

    await pool.query("CALL sp_delete_discount(?)", [discountCode]);

    res.json({ message: "Discount deleted successfully." });
  } catch (error) {
    res.status(400).json({ message: getSqlError(error) });
  }
});

// 7. Bookings by discount
app.get("/api/bookings-by-discount", async (req, res) => {
  try {
    const discountCode = req.query.discountCode || null;
    const status = req.query.status || null;
    const fromDate = req.query.fromDate || null;
    const toDate = req.query.toDate || null;

    const [rows] = await pool.query(
      "CALL sp_get_bookings_by_discount(?, ?, ?, ?)",
      [discountCode, status, fromDate, toDate]
    );

    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: getSqlError(error) });
  }
});

// 8. Function demo: booking total
app.get("/api/functions/booking-total/:bookingId", async (req, res) => {
  try {
    const bookingId = req.params.bookingId;

    const [rows] = await pool.query(
      "SELECT fn_calculate_booking_total(?) AS booking_total",
      [bookingId]
    );

    res.json(rows[0]);
  } catch (error) {
    res.status(400).json({ message: getSqlError(error) });
  }
});

// 9. Function demo: customer loyalty points
app.get("/api/functions/customer-points/:customerId", async (req, res) => {
  try {
    const customerId = req.params.customerId;

    const [rows] = await pool.query(
      "SELECT fn_calculate_customer_points(?) AS loyalty_points",
      [customerId]
    );

    res.json(rows[0]);
  } catch (error) {
    res.status(400).json({ message: getSqlError(error) });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Backend running at http://localhost:${port}`);
});