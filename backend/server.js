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

const SAMPLE_TABLES = [
  "ADMIN",
  "BOOKING",
  "CREDIT_CARD",
  "CUSTOMER",
  "DISCOUNT",
  "E_WALLET",
  "GIFT_CARD",
  "MOVIE",
  "MOVIE_GENRE",
  "OPERATOR",
  "PAYMENT_METHOD",
  "ROOM",
  "SEAT",
  "SHOWTIME",
  "STAFF",
  "THEATER",
  "THEATER_HOTLINE",
  "TICKET",
  "USER",
  "WORK_AT",
];

const SAMPLE_TABLE_ORDER = {
  ADMIN: ["StaffID"],
  BOOKING: ["Booking_date", "BookingID"],
  CREDIT_CARD: ["PaymentID"],
  CUSTOMER: ["UserID"],
  DISCOUNT: ["Expiry_date", "DiscountCode"],
  E_WALLET: ["PaymentID"],
  GIFT_CARD: ["PaymentID"],
  MOVIE: ["Release_date", "MovieID"],
  MOVIE_GENRE: ["MovieID", "Genre"],
  OPERATOR: ["StaffID"],
  PAYMENT_METHOD: ["PaymentID"],
  ROOM: ["TheaterID", "RoomNo"],
  SEAT: ["TheaterID", "RoomNo", "SeatID"],
  SHOWTIME: ["Start_datetime", "ShowID"],
  STAFF: ["UserID"],
  THEATER: ["TheaterID"],
  THEATER_HOTLINE: ["TheaterID", "Hotline"],
  TICKET: ["TicketNo"],
  USER: ["UserID"],
  WORK_AT: ["StaffID", "TheaterID"],
};

function findSampleTable(tableName) {
  const normalizedName = String(tableName || "").trim().toUpperCase();
  return SAMPLE_TABLES.find((table) => table === normalizedName);
}

const DEMO_AUTO_DATES = process.env.DEMO_AUTO_DATES !== "false";
const DEMO_FIRST_SHOW_OFFSET_DAYS = Number(
  process.env.DEMO_FIRST_SHOW_OFFSET_DAYS || 1
);
const DEMO_TEMP_SHIFT_DAYS = 3650;
const DEMO_DATE_LOCK = "ticket4u:demo_schedule_dates";

async function shiftShowtimesByDays(conn, dayShift) {
  if (!Number.isFinite(dayShift) || dayShift === 0) return;

  await conn.query(
    `
    UPDATE SHOWTIME
    SET Start_datetime = DATE_ADD(Start_datetime, INTERVAL ? DAY),
        End_datetime = DATE_ADD(End_datetime, INTERVAL ? DAY)
    `,
    [dayShift, dayShift]
  );
}

async function refreshDemoBookingDates(conn) {
  await conn.query(`
    UPDATE BOOKING b
    JOIN (
      SELECT
        tk.BookingID,
        MIN(s.Start_datetime) AS FirstShowStart
      FROM TICKET tk
      JOIN SHOWTIME s ON s.ShowID = tk.ShowID
      GROUP BY tk.BookingID
    ) first_show ON first_show.BookingID = b.BookingID
    SET
      b.Booking_date = DATE_ADD(
        DATE_SUB(first_show.FirstShowStart, INTERVAL 2 DAY),
        INTERVAL (MOD(CAST(SUBSTRING(b.BookingID, 2) AS UNSIGNED), 18) * 5) MINUTE
      ),
      b.Expired_time = DATE_ADD(
        DATE_ADD(
          DATE_SUB(first_show.FirstShowStart, INTERVAL 2 DAY),
          INTERVAL (MOD(CAST(SUBSTRING(b.BookingID, 2) AS UNSIGNED), 18) * 5) MINUTE
        ),
        INTERVAL 15 MINUTE
      )
    WHERE b.BookingID REGEXP '^B[0-9]+$'
      AND CAST(SUBSTRING(b.BookingID, 2) AS UNSIGNED) <= 50
  `);
}

async function refreshDemoExpirations(conn) {
  await conn.query(`
    UPDATE DISCOUNT
    SET Expiry_date = DATE_ADD(CURDATE(), INTERVAL 1 YEAR)
    WHERE Expiry_date < DATE_ADD(CURDATE(), INTERVAL 1 YEAR)
  `);

  await conn.query(`
    UPDATE GIFT_CARD
    SET Expiry_date = DATE_ADD(CURDATE(), INTERVAL 1 YEAR)
    WHERE Expiry_date < DATE_ADD(CURDATE(), INTERVAL 1 YEAR)
  `);
}

async function ensureDemoScheduleDates(conn) {
  if (!DEMO_AUTO_DATES) return;

  const [[lockResult]] = await conn.query("SELECT GET_LOCK(?, 10) AS locked", [
    DEMO_DATE_LOCK,
  ]);

  if (Number(lockResult.locked) !== 1) {
    throw new Error("Unable to refresh demo schedule dates. Please try again.");
  }

  try {
    const [[scheduleInfo]] = await conn.query(
      `
      SELECT
        COUNT(*) AS ShowtimeCount,
        DATEDIFF(
          DATE_ADD(CURDATE(), INTERVAL ? DAY),
          DATE(MIN(Start_datetime))
        ) AS DayShift
      FROM SHOWTIME
      WHERE Status IN ('scheduled', 'open')
      `,
      [DEMO_FIRST_SHOW_OFFSET_DAYS]
    );

    const showtimeCount = Number(scheduleInfo?.ShowtimeCount || 0);
    const dayShift = Number(scheduleInfo?.DayShift || 0);

    if (showtimeCount > 0 && dayShift !== 0) {
      await shiftShowtimesByDays(conn, DEMO_TEMP_SHIFT_DAYS);

      const [[tempScheduleInfo]] = await conn.query(
        `
        SELECT DATEDIFF(
          DATE_ADD(CURDATE(), INTERVAL ? DAY),
          DATE(MIN(Start_datetime))
        ) AS DayShift
        FROM SHOWTIME
        WHERE Status IN ('scheduled', 'open')
        `,
        [DEMO_FIRST_SHOW_OFFSET_DAYS]
      );

      await shiftShowtimesByDays(conn, Number(tempScheduleInfo?.DayShift || 0));
      await refreshDemoBookingDates(conn);
    }

    await refreshDemoExpirations(conn);
  } finally {
    await conn.query("SELECT RELEASE_LOCK(?)", [DEMO_DATE_LOCK]).catch(() => {});
  }
}

async function releaseExpiredPendingBookings(conn) {
  await conn.query(`
    UPDATE PAYMENT_METHOD pm
    JOIN BOOKING b ON b.PaymentID = pm.PaymentID
    SET pm.Status = 'Failed'
    WHERE b.Status = 'Pending'
      AND b.Expired_time <= NOW()
      AND pm.Status = 'Pending'
  `);

  await conn.query(`
    DELETE tk
    FROM TICKET tk
    JOIN BOOKING b ON b.BookingID = tk.BookingID
    WHERE b.Status = 'Pending'
      AND b.Expired_time <= NOW()
  `);

  await conn.query(`
    UPDATE BOOKING
    SET Status = 'Cancelled'
    WHERE Status = 'Pending'
      AND Expired_time <= NOW()
  `);
}

async function prepareDemoData(existingConn = null) {
  let conn = existingConn;
  let shouldRelease = false;

  if (!conn) {
    conn = await db.getConnection();
    shouldRelease = true;
  }

  try {
    await ensureDemoScheduleDates(conn);
    await releaseExpiredPendingBookings(conn);
  } finally {
    if (shouldRelease) {
      conn.release();
    }
  }
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

// Read-only sample data browser for reports/demo tools such as Excel Power Query.
app.get("/api/tables", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT TABLE_NAME AS tableName, TABLE_ROWS AS estimatedRows
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (?)
      ORDER BY TABLE_NAME
      `,
      [SAMPLE_TABLES]
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: getSqlError(error) });
  }
});

app.get("/api/tables/:tableName", async (req, res) => {
  try {
    const tableName = findSampleTable(req.params.tableName);

    if (!tableName) {
      return res.status(404).json({
        message: "Table is not available through the sample data API.",
      });
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    const useLatestOrder = req.query.latest === "true";

    if (["BOOKING", "DISCOUNT", "GIFT_CARD", "SHOWTIME", "TICKET"].includes(tableName)) {
      await prepareDemoData();
    }

    if (tableName === "TICKET" && useLatestOrder) {
      const [rows] = await pool.query(
        `
        SELECT
          tk.*,
          b.Booking_date,
          b.CustomerID,
          b.Status AS BookingStatus,
          b.Total_price
        FROM TICKET tk
        JOIN BOOKING b ON b.BookingID = tk.BookingID
        ORDER BY b.Booking_date DESC, tk.TicketNo DESC
        LIMIT ?
        `,
        [limit]
      );

      return res.json(rows);
    }

    const orderColumns = useLatestOrder
      ? SAMPLE_TABLE_ORDER[tableName] || []
      : [];
    const bookingId =
      typeof req.query.bookingId === "string"
        ? req.query.bookingId.trim().toUpperCase()
        : "";

    if (bookingId && tableName === "BOOKING") {
      const [rows] = await pool.query(
        "SELECT * FROM BOOKING WHERE BookingID = ? LIMIT ?",
        [bookingId, limit]
      );

      return res.json(rows);
    }

    if (bookingId && tableName === "TICKET") {
      const [rows] = await pool.query(
        `
        SELECT *
        FROM TICKET
        WHERE BookingID = ?
        ORDER BY TicketNo
        LIMIT ?
        `,
        [bookingId, limit]
      );

      return res.json(rows);
    }

    if (useLatestOrder && tableName === "TICKET") {
      const [rows] = await pool.query(
        `
        SELECT t.*
        FROM TICKET t
        JOIN BOOKING b ON b.BookingID = t.BookingID
        ORDER BY b.Booking_date DESC, t.TicketNo DESC
        LIMIT ?
        `,
        [limit]
      );

      return res.json(rows);
    }

    let sql = "SELECT * FROM ??";
    const params = [tableName];

    if (orderColumns.length > 0) {
      sql += ` ORDER BY ${orderColumns.map(() => "?? DESC").join(", ")}`;
      params.push(...orderColumns);
    }

    sql += " LIMIT ?";
    params.push(limit);

    const [rows] = await pool.query(sql, params);

    res.json(rows);
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
    await prepareDemoData();

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
          tk.ShowID,
          tk.RoomNo,
          tk.TheaterID,
          COUNT(*) AS BookedSeats
        FROM TICKET tk
        JOIN BOOKING b ON b.BookingID = tk.BookingID
        WHERE b.Status = 'Paid'
           OR (b.Status = 'Pending' AND b.Expired_time > NOW())
        GROUP BY tk.ShowID, tk.RoomNo, tk.TheaterID
      ) ticket_counts
        ON ticket_counts.ShowID = s.ShowID
       AND ticket_counts.RoomNo = s.RoomNo
       AND ticket_counts.TheaterID = s.TheaterID
      WHERE s.Status IN ('scheduled', 'open')
        AND s.Start_datetime > NOW()
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

    await prepareDemoData();

    const [rows] = await db.query(
      `
      SELECT
        se.SeatID,
        se.Seat_type,
        se.Condition,
        CASE
          WHEN se.Condition = 'broken' THEN 'broken'
          WHEN se.Condition = 'reserved' THEN 'reserved'
          WHEN active_tickets.TicketNo IS NOT NULL THEN 'booked'
          ELSE 'available'
        END AS SeatStatus
      FROM SHOWTIME sh
      JOIN SEAT se
        ON se.RoomNo = sh.RoomNo
       AND se.TheaterID = sh.TheaterID
      LEFT JOIN (
        SELECT
          tk.TicketNo,
          tk.SeatID,
          tk.RoomNo,
          tk.TheaterID,
          tk.ShowID
        FROM TICKET tk
        JOIN BOOKING b ON b.BookingID = tk.BookingID
        WHERE b.Status = 'Paid'
           OR (b.Status = 'Pending' AND b.Expired_time > NOW())
      ) active_tickets
        ON active_tickets.SeatID = se.SeatID
       AND active_tickets.RoomNo = se.RoomNo
       AND active_tickets.TheaterID = se.TheaterID
       AND active_tickets.ShowID = sh.ShowID
      WHERE sh.ShowID = ?
        AND sh.Status IN ('scheduled', 'open')
        AND sh.Start_datetime > NOW()
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

async function acquireNamedLock(conn, lockName) {
  const [[lockResult]] = await conn.query("SELECT GET_LOCK(?, 10) AS locked", [
    lockName,
  ]);

  if (Number(lockResult.locked) !== 1) {
    throw new Error("Unable to reserve the next ID. Please try again.");
  }
}

async function releaseNamedLocks(conn, lockNames) {
  for (const lockName of [...lockNames].reverse()) {
    await conn.query("SELECT RELEASE_LOCK(?)", [lockName]);
  }
}

async function getNextIds(
  conn,
  tableName,
  columnName,
  prefix,
  count = 1,
  minDigits = 3
) {
  const [rows] = await conn.query(
    `
    SELECT CAST(SUBSTRING(??, ?) AS UNSIGNED) AS idNumber
    FROM ??
    WHERE ?? REGEXP ?
    ORDER BY idNumber
    `,
    [
      columnName,
      prefix.length + 1,
      tableName,
      columnName,
      `^${prefix}[0-9]+$`,
    ]
  );

  const usedNumbers = new Set(rows.map((row) => Number(row.idNumber)));
  const ids = [];
  let nextNumber = 1;

  while (ids.length < count) {
    if (!usedNumbers.has(nextNumber)) {
      const digits = Math.max(minDigits, String(nextNumber).length);
      ids.push(`${prefix}${String(nextNumber).padStart(digits, "0")}`);
      usedNumbers.add(nextNumber);
    }

    nextNumber += 1;
  }

  return ids;
}

async function getNextId(conn, tableName, columnName, prefix, minDigits = 3) {
  const [nextId] = await getNextIds(
    conn,
    tableName,
    columnName,
    prefix,
    1,
    minDigits
  );

  return nextId;
}

function getPriceBySeatType(seatType) {
  if (seatType === "VIP") return 120000;
  if (seatType === "Sweetbox") return 160000;
  return 90000;
}

app.post("/api/bookings", async (req, res) => {
  let conn;
  const acquiredIdLocks = [];
  const idLocks = [
    "ticket4u:BOOKING.BookingID",
    "ticket4u:PAYMENT_METHOD.PaymentID",
    "ticket4u:TICKET.TicketNo",
  ];

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

    await prepareDemoData(conn);
    await conn.beginTransaction();

    for (const lockName of idLocks) {
      await acquireNamedLock(conn, lockName);
      acquiredIdLocks.push(lockName);
    }

    const [[showtime]] = await conn.query(
      `
      SELECT ShowID, RoomNo, TheaterID, Start_datetime
      FROM SHOWTIME
      WHERE ShowID = ?
        AND Status IN ('scheduled', 'open')
        AND Start_datetime > NOW()
      `,
      [showId]
    );

    if (!showtime) {
      throw new Error("Showtime is not available for booking.");
    }

    const bookingId = await getNextId(conn, "BOOKING", "BookingID", "B");
    const paymentId = await getNextId(
      conn,
      "PAYMENT_METHOD",
      "PaymentID",
      "P"
    );
    const ticketNos = await getNextIds(
      conn,
      "TICKET",
      "TicketNo",
      "TK",
      seats.length
    );
    let ticketIndex = 0;

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
        SELECT tk.TicketNo
        FROM TICKET tk
        JOIN BOOKING b ON b.BookingID = tk.BookingID
        WHERE tk.SeatID = ?
          AND tk.RoomNo = ?
          AND tk.TheaterID = ?
          AND tk.ShowID = ?
          AND (
            b.Status = 'Paid'
            OR (b.Status = 'Pending' AND b.Expired_time > NOW())
          )
        `,
        [seatId, showtime.RoomNo, showtime.TheaterID, showId]
      );

      if (existingTicket) {
        throw new Error(`Seat ${seatId} has already been booked.`);
      }

      const ticketNo = ticketNos[ticketIndex];
      ticketIndex += 1;
      const qrCode = `QR-${ticketNo}`;
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
      if (acquiredIdLocks.length > 0) {
        await releaseNamedLocks(conn, acquiredIdLocks).catch(() => {});
      }

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

    await prepareDemoData(conn);
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

    if (booking.Status === "Cancelled") {
      throw new Error("Cannot change discount for a cancelled booking.");
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

    await prepareDemoData(conn);
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

    if (booking.Status === "Cancelled") {
      throw new Error("This booking has expired or was cancelled. Please create a new booking.");
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

    await prepareDemoData();

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

