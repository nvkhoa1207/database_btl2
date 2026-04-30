const path = require("path");
const express = require("express");

const cors = require("cors");

const pool = require("./db");
const app = express();
const db = require("./db");
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..")));

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





app.get("/api/showtimes", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        s.ShowID,
        s.Start_datetime,
        s.End_datetime,
        s.RoomNo,
        s.TheaterID,
        m.Title AS MovieTitle,
        m.Age_restriction,
        t.Name AS TheaterName,
        r.Name AS RoomName,
        r.Capacity AS RoomCapacity,
        COALESCE(seat_counts.TotalSeats, 0) AS TotalSeats,
        GREATEST(
          COALESCE(seat_counts.AvailableSeats, 0) - COALESCE(ticket_counts.BookedSeats, 0),
          0
        ) AS AvailableSeats
      FROM SHOWTIME s
      JOIN MOVIE m ON m.MovieID = s.MovieID
      JOIN THEATER t ON t.TheaterID = s.TheaterID
      JOIN ROOM r ON r.RoomNo = s.RoomNo AND r.TheaterID = s.TheaterID
      LEFT JOIN (
        SELECT
          RoomNo,
          TheaterID,
          COUNT(*) AS TotalSeats,
          SUM(CASE WHEN \`Condition\` = 'usable' THEN 1 ELSE 0 END) AS AvailableSeats
        FROM SEAT
        GROUP BY RoomNo, TheaterID
      ) seat_counts
        ON seat_counts.RoomNo = s.RoomNo
       AND seat_counts.TheaterID = s.TheaterID
      LEFT JOIN (
        SELECT
          ShowID,
          RoomNo,
          TheaterID,
          COUNT(*) AS BookedSeats
        FROM TICKET
        GROUP BY ShowID, RoomNo, TheaterID
      ) ticket_counts
        ON ticket_counts.ShowID = s.ShowID
       AND ticket_counts.RoomNo = s.RoomNo
       AND ticket_counts.TheaterID = s.TheaterID
      WHERE s.Status IN ('scheduled', 'open')
      ORDER BY s.Start_datetime;
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Cannot load showtimes."
    });
  }
});


app.get("/api/showtimes/:showId/seats", async (req, res) => {
  try {
    const { showId } = req.params;

    const [rows] = await db.query(
      `
      SELECT
        se.SeatID,
        se.Seat_type,
        se.Condition,
        CASE
          WHEN se.Condition = 'broken' THEN 'broken'
          WHEN se.Condition = 'reserved' THEN 'reserved'
          WHEN tk.TicketNo IS NOT NULL THEN 'booked'
          ELSE 'available'
        END AS SeatStatus
      FROM SHOWTIME sh
      JOIN SEAT se
        ON se.RoomNo = sh.RoomNo
       AND se.TheaterID = sh.TheaterID
      LEFT JOIN TICKET tk
        ON tk.SeatID = se.SeatID
       AND tk.RoomNo = se.RoomNo
       AND tk.TheaterID = se.TheaterID
       AND tk.ShowID = sh.ShowID
      WHERE sh.ShowID = ?
      ORDER BY
        LEFT(se.SeatID, 1),
        CAST(SUBSTRING(se.SeatID, 2) AS UNSIGNED),
        se.SeatID;
      `,
      [showId]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Cannot load seats.",
      error: err.message
    });
  }
});

function makeId(prefix, length = 6) {
  const randomPart = Math.floor(Math.random() * 10 ** length)
    .toString()
    .padStart(length, "0");

  return `${prefix}${randomPart}`;
}

function getPriceBySeatType(seatType) {
  if (seatType === "VIP") return 120000;
  if (seatType === "Sweetbox") return 160000;
  return 90000;
}

app.post("/api/bookings", async (req, res) => {
  let conn;

  try {
    conn = await db.getConnection();

    const {
      customerId = "U001",
      showId,
      seats,
      discountCode = null
    } = req.body;

    if (!showId) {
      return res.status(400).json({ message: "Showtime is required." });
    }

    if (!Array.isArray(seats) || seats.length === 0) {
      return res.status(400).json({ message: "At least one seat must be selected." });
    }

    await conn.beginTransaction();

    const [[showtime]] = await conn.query(
      `
      SELECT ShowID, RoomNo, TheaterID
      FROM SHOWTIME
      WHERE ShowID = ?
      `,
      [showId]
    );

    if (!showtime) {
      throw new Error("Invalid showtime.");
    }

    const bookingId = makeId("B");
    const paymentId = makeId("P");

    await conn.query(
      `
      INSERT INTO PAYMENT_METHOD(PaymentID, Amount, Status)
      VALUES (?, 0, 'Pending')
      `,
      [paymentId]
    );

    await conn.query(
      `
      INSERT INTO BOOKING(
        BookingID, CustomerID, Booking_date, Platform, PaymentID,
        DiscountCode, Status, Expired_time, Total_price
      )
      VALUES (
        ?, ?, NOW(), 'Web', ?, ?, 'Pending',
        DATE_ADD(NOW(), INTERVAL 15 MINUTE), 0
      )
      `,
      [bookingId, customerId, paymentId, discountCode]
    );

    for (const seatId of seats) {
      const [[seat]] = await conn.query(
        `
        SELECT SeatID, Seat_type, \`Condition\`
        FROM SEAT
        WHERE SeatID = ?
          AND RoomNo = ?
          AND TheaterID = ?
        `,
        [seatId, showtime.RoomNo, showtime.TheaterID]
      );

      if (!seat) {
        throw new Error(`Seat ${seatId} does not exist.`);
      }

      if (seat.Condition !== "usable") {
        throw new Error(`Seat ${seatId} is not usable.`);
      }

      const [[existingTicket]] = await conn.query(
        `
        SELECT TicketNo
        FROM TICKET
        WHERE SeatID = ?
          AND RoomNo = ?
          AND TheaterID = ?
          AND ShowID = ?
        `,
        [seatId, showtime.RoomNo, showtime.TheaterID, showId]
      );

      if (existingTicket) {
        throw new Error(`Seat ${seatId} has already been booked.`);
      }

      const ticketNo = makeId("TK", 6);
      const qrCode = `QR-${bookingId}-${seatId}`;
      const price = getPriceBySeatType(seat.Seat_type);

      await conn.query(
        `
        INSERT INTO TICKET(
          TicketNo, BookingID, ShowID, SeatID, RoomNo, TheaterID,
          Scanned_by, Price, Qr_code
        )
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `,
        [
          ticketNo,
          bookingId,
          showId,
          seatId,
          showtime.RoomNo,
          showtime.TheaterID,
          price,
          qrCode
        ]
      );
    }

    const [[booking]] = await conn.query(
      `
      SELECT
        b.BookingID,
        b.CustomerID,
        b.PaymentID,
        b.DiscountCode,
        b.Status,
        b.Total_price,
        COALESCE((
          SELECT SUM(t.Price)
          FROM TICKET t
          WHERE t.BookingID = b.BookingID
        ), 0) AS TicketSubtotal,
        COALESCE(d.Discount_value, 0) AS DiscountValue
      FROM BOOKING b
      LEFT JOIN DISCOUNT d ON d.DiscountCode = b.DiscountCode
      WHERE b.BookingID = ?
      `,
      [bookingId]
    );

    await conn.commit();

    res.json({
      message: "Booking created successfully.",
      booking
    });
  } catch (err) {
    if (conn) {
      await conn.rollback();
    }

    res.status(400).json({
      message: err.sqlMessage || err.message
    });
  } finally {
    if (conn) {
      conn.release();
    }
  }
});

app.put("/api/bookings/:bookingId/discount", async (req, res) => {
  let conn;

  try {
    conn = await db.getConnection();

    const { bookingId } = req.params;
    const rawDiscountCode = req.body.discountCode;
    const discountCode =
      typeof rawDiscountCode === "string" && rawDiscountCode.trim() !== ""
        ? rawDiscountCode.trim().toUpperCase()
        : null;

    await conn.beginTransaction();

    const [[booking]] = await conn.query(
      `
      SELECT BookingID, PaymentID, Status
      FROM BOOKING
      WHERE BookingID = ?
      FOR UPDATE
      `,
      [bookingId]
    );

    if (!booking) {
      throw new Error("Booking does not exist.");
    }

    if (booking.Status === "Paid") {
      throw new Error("Cannot change discount after payment.");
    }

    const [[subtotalRow]] = await conn.query(
      `
      SELECT COALESCE(SUM(Price), 0) AS TicketSubtotal
      FROM TICKET
      WHERE BookingID = ?
      `,
      [bookingId]
    );

    const ticketSubtotal = Number(subtotalRow.TicketSubtotal || 0);
    let discountValue = 0;
    let appliedDiscountCode = null;
    let discountName = null;

    if (discountCode) {
      const [[discount]] = await conn.query(
        `
        SELECT DiscountCode, Name, Discount_value, Expiry_date
        FROM DISCOUNT
        WHERE DiscountCode = ?
        `,
        [discountCode]
      );

      if (!discount) {
        throw new Error("Discount code is invalid.");
      }

      if (new Date(discount.Expiry_date) < new Date(new Date().toDateString())) {
        throw new Error("Discount code has expired.");
      }

      discountValue = Number(discount.Discount_value || 0);
      appliedDiscountCode = discount.DiscountCode;
      discountName = discount.Name;
    }

    const totalPrice = Math.max(ticketSubtotal - discountValue, 0);

    await conn.query(
      `
      UPDATE BOOKING
      SET DiscountCode = ?,
          Total_price = ?
      WHERE BookingID = ?
      `,
      [appliedDiscountCode, totalPrice, bookingId]
    );

    if (booking.PaymentID) {
      await conn.query(
        `
        UPDATE PAYMENT_METHOD
        SET Amount = ?
        WHERE PaymentID = ?
          AND Status = 'Pending'
        `,
        [totalPrice, booking.PaymentID]
      );
    }

    const [[updatedBooking]] = await conn.query(
      `
      SELECT
        b.BookingID,
        b.CustomerID,
        b.PaymentID,
        b.DiscountCode,
        b.Status,
        b.Total_price,
        ? AS TicketSubtotal,
        ? AS DiscountValue,
        ? AS DiscountName
      FROM BOOKING b
      WHERE b.BookingID = ?
      `,
      [ticketSubtotal, discountValue, discountName, bookingId]
    );

    await conn.commit();

    res.json({
      message: appliedDiscountCode
        ? "Discount applied successfully."
        : "Discount removed successfully.",
      booking: updatedBooking
    });
  } catch (err) {
    if (conn) {
      await conn.rollback();
    }

    res.status(400).json({
      message: err.sqlMessage || err.message
    });
  } finally {
    if (conn) {
      conn.release();
    }
  }
});

app.put("/api/bookings/:bookingId/pay", async (req, res) => {
  let conn;

  try {
    conn = await db.getConnection();

    const { bookingId } = req.params;

    await conn.beginTransaction();

    const [[booking]] = await conn.query(
      `
      SELECT BookingID, PaymentID, Total_price, Status
      FROM BOOKING
      WHERE BookingID = ?
      FOR UPDATE
      `,
      [bookingId]
    );

    if (!booking) {
      throw new Error("Booking does not exist.");
    }

    if (booking.Status === "Paid") {
      throw new Error("This booking has already been paid.");
    }

    if (!booking.PaymentID) {
      throw new Error("This booking does not have a payment method.");
    }

    await conn.query(
      `
      UPDATE BOOKING
      SET Status = 'Paid'
      WHERE BookingID = ?
      `,
      [bookingId]
    );

    await conn.query(
      `
      UPDATE PAYMENT_METHOD
      SET Amount = ?,
          Status = 'Success'
      WHERE PaymentID = ?
      `,
      [booking.Total_price, booking.PaymentID]
    );

    const [[updatedBooking]] = await conn.query(
      `
      SELECT
        b.BookingID,
        b.CustomerID,
        b.PaymentID,
        b.Status,
        b.Total_price,
        pm.Status AS PaymentStatus,
        pm.Amount AS PaymentAmount,
        b.DiscountCode
      FROM BOOKING b
      JOIN PAYMENT_METHOD pm ON pm.PaymentID = b.PaymentID
      WHERE b.BookingID = ?
      `,
      [bookingId]
    );

    await conn.commit();

    res.json({
      message: "Payment confirmed successfully.",
      booking: updatedBooking
    });
  } catch (err) {
    if (conn) {
      await conn.rollback();
    }

    res.status(400).json({
      message: err.sqlMessage || err.message
    });
  } finally {
    if (conn) {
      conn.release();
    }
  }
});
const port = process.env.PORT || 3000;
app.get("/api/bookings/:bookingId/ticket", async (req, res) => {
  try {
    const { bookingId } = req.params;

    const [rows] = await db.query(
      `
      SELECT
        b.BookingID,
        b.Booking_date,
        b.Status AS BookingStatus,
        b.Total_price,
        tk.TicketNo,
        tk.SeatID,
        tk.RoomNo,
        tk.TheaterID,
        tk.Price,
        tk.Qr_code,
        s.ShowID,
        s.Start_datetime,
        m.Title AS MovieTitle,
        th.Name AS TheaterName,
        r.Name AS RoomName,
        b.DiscountCode,
        COALESCE(d.Name, '') AS DiscountName,
        COALESCE(d.Discount_value, 0) AS DiscountValue
      FROM BOOKING b
      JOIN TICKET tk ON tk.BookingID = b.BookingID
      JOIN SHOWTIME s ON s.ShowID = tk.ShowID
      JOIN MOVIE m ON m.MovieID = s.MovieID
      JOIN THEATER th ON th.TheaterID = tk.TheaterID
      JOIN ROOM r ON r.RoomNo = tk.RoomNo AND r.TheaterID = tk.TheaterID
      LEFT JOIN DISCOUNT d ON d.DiscountCode = b.DiscountCode
      WHERE b.BookingID = ?
      ORDER BY tk.SeatID;
      `,
      [bookingId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Ticket not found."
      });
    }

    res.json({
      bookingId: rows[0].BookingID,
      status: rows[0].BookingStatus,
      totalPrice: rows[0].Total_price,
      movieTitle: rows[0].MovieTitle,
      theaterName: rows[0].TheaterName,
      roomNo: rows[0].RoomNo,
      roomName: rows[0].RoomName,
      discountCode: rows[0].DiscountCode,
      discountName: rows[0].DiscountName,
      discountValue: rows[0].DiscountValue,
      showTime: rows[0].Start_datetime,
      seats: rows.map(row => row.SeatID),
      tickets: rows
    });
  } catch (err) {
    res.status(500).json({
      message: err.sqlMessage || err.message
    });
  }
});
if (process.env.VERCEL !== "1") {
  app.listen(port, () => {
    console.log(`Backend running at http://localhost:${port}`);
  });
}

module.exports = app;

