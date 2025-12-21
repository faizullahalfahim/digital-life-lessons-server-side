require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Middleware
app.use(
  cors({
    origin: [process.env.SITE_DOMAIN],
  })
);
app.use(express.json());
const port = 3000;

//jwt middleWire
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

app.get("/", (req, res) => {
  res.send("Digital Life Lessons Server is running");
});

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("digital_life_lessons");
    const lessonsCollection = db.collection("lessons");
    const paymentsCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const commentCollection = db.collection("comments");
    const favoritesCollection = db.collection("favorites");
    const reportCollection = db.collection("report");

    //save lesson to database
    app.get("/lessons", async (req, res) => {
      try {
        const {
          page = 0,
          size = 8,
          search = "",
          category = "",
          emotionalTone = "",
          sort = "newest",
        } = req.query;

        const pageNum = parseInt(page);
        const sizeNum = parseInt(size);

        let query = { visibility: "public" };

        if (search) {
          query.title = { $regex: search, $options: "i" };
        }
        if (category) {
          query.category = category;
        }
        if (emotionalTone) {
          query.emotionalTone = emotionalTone;
        }

        let sortOptions = {};
        if (sort === "newest") {
          sortOptions = { createdAt: -1 };
        } else if (sort === "mostSaved") {
          sortOptions = { favoritesCount: -1 };
        }

        const lessons = await lessonsCollection
          .find(query)
          .sort(sortOptions)
          .skip(pageNum * sizeNum)
          .limit(sizeNum)
          .toArray();

        const count = await lessonsCollection.countDocuments(query);

        res.send({ lessons, count });
      } catch (error) {
        res.status(500).send({ message: "Error fetching lessons", error });
      }
    });

    // All lessons related APIs

    //get lessons for public lessons
    app.get("/lessons", async (req, res) => {
      const lessons = await lessonsCollection.find().toArray();
      res.send(lessons);
    });
    //get lessons by id for details
    app.get("/lessons/:id", async (req, res) => {
      const id = req.params.id;
      const lesson = await lessonsCollection.findOne({ _id: new ObjectId(id) });
      res.send(lesson);
    });

    //payment endpoint
    // payment related apis
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.planName,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: paymentInfo.customer.email,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (
          session.payment_status === "paid" &&
          session.status === "complete"
        ) {
          const userEmail = session.customer_email;

          const userUpdate = await usersCollection.updateOne(
            { email: userEmail },
            { $set: { isPremium: true } }
          );

          const paymentRecord = {
            userEmail,
            transactionId: session.payment_intent,
            amount: session.amount_total / 100,
            currency: session.currency,
            timestamp: new Date().toISOString(),
            plan: "Lifetime Premium",
            status: "completed",
          };

          await paymentsCollection.updateOne(
            { transactionId: session.payment_intent },
            { $set: paymentRecord },
            { upsert: true }
          );

          res.send({ success: true, message: "User upgraded to Premium" });
        } else {
          res.status(400).send({ message: "Payment not verified" });
        }
      } catch (err) {
        res.status(500).send({ message: "Server Error", error: err.message });
      }
    });

    //get my lessons by email
    app.get("/my-lessons", verifyJWT, async (req, res) => {
      const email = req.params.email;
      const lessons = await lessonsCollection
        .find({
          creator: req.tokenEmail,
        })
        .toArray();
      res.send(lessons);
    });

    // save or update user info
    app.post("/users", async (req, res) => {
      const userData = req.body;
      userData.createdAt = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "user";
      const query = {
        email: userData.email,
      };
      const alreadyExists = await usersCollection.findOne({
        email: userData.email,
      });
      console.log("user already exists ===> ", !!alreadyExists);
      if (alreadyExists) {
        console.log("updating user info ..");
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }
      console.log("saving new user info");

      const result = await usersCollection.insertOne(userData);
      res.send(userData);
    });

    //get a user's role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({
        role: result?.role || "user",
        isPremium: result?.isPremium || false,
      });
    });
    // get all users
    app.get("/users", verifyJWT, async (req, res) => {
      const searchText = req.query.searchText || "";

      const filter = searchText
        ? {
            $or: [
              { displayName: { $regex: searchText, $options: "i" } },
              { email: { $regex: searchText, $options: "i" } },
            ],
          }
        : {};

      const users = await usersCollection
        .aggregate([
          { $match: filter },

          {
            $lookup: {
              from: "lessons",
              localField: "email",
              foreignField: "creator",
              as: "userLessons",
            },
          },

          {
            $addFields: {
              totalLessons: { $size: "$userLessons" },
            },
          },

          {
            $project: {
              userLessons: 0,
            },
          },
        ])
        .toArray();

      res.send(users);
    });
    // update user role
    app.patch("/users/:id/role", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          role: roleInfo.role,
        },
      };
      const result = await usersCollection.updateOne(query, updatedDoc);
      res.send(result);
    });
    // delete lesson by id
    app.delete("/lessons/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await lessonsCollection.deleteOne(query);
      res.send(result);
    });
    //post comment
    app.post("/comments", async (req, res) => {
      const commentData = req.body;
      commentData.lessonId = new ObjectId(commentData.lessonId);
      const result = await commentCollection.insertOne(commentData);
      res.send(result);
    });
    //get comment

    app.get("/comments/:lessonId", async (req, res) => {
      try {
        const id = req.params.lessonId;
        const query = { lessonId: new ObjectId(id) };
        const result = await commentCollection
          .find(query)
          .sort({ date: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching comments:", error);
        res.status(500).send({ message: "Failed to load comments" });
      }
    });

    //post to favorites

    app.post("/favorites", async (req, res) => {
      const favoriteData = req.body;

      const query = {
        userEmail: favoriteData.userEmail,
        lessonId: favoriteData.lessonId,
      };

      const alreadyExists = await favoritesCollection.findOne(query);

      if (alreadyExists) {
        return res.send({ message: "Already added to favorites" });
      }

      const result = await favoritesCollection.insertOne(favoriteData);
      res.send(result);
    });
    //get favorites
    app.get("/favorites/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;

      if (req.tokenEmail !== email) {
        return res.status(403).send({ message: "Forbidden Access" });
      }

      const query = { userEmail: email };
      const result = await favoritesCollection.find(query).toArray();
      res.send(result);
    });

    app.delete("/favorites/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await favoritesCollection.deleteOne(query);
      res.send(result);
    });
    // Update lesson visibility and access level
    app.patch("/lessons/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const { title, description, category, visibility, accessLevel, image } =
        req.body;
      const query = { _id: new ObjectId(id) };

      try {
        const lesson = await lessonsCollection.findOne(query);
        if (!lesson) {
          return res.status(404).send({ message: "Lesson not found" });
        }

        if (lesson.creator !== req.tokenEmail) {
          const user = await usersCollection.findOne({ email: req.tokenEmail });
          if (user.role !== "admin") {
            return res.status(403).send({
              message: "You don't have permission to update this lesson",
            });
          }
        }

        if (accessLevel && accessLevel.toLowerCase() === "premium") {
          const user = await usersCollection.findOne({ email: req.tokenEmail });
          if (user.role !== "premium" && user.role !== "admin") {
            return res.status(403).send({
              message: "Only premium users can set premium access level",
            });
          }
        }

        const updatedDoc = {
          $set: {
            ...(title && { title }),
            ...(description && { description }),
            ...(category && { category }),
            ...(visibility && { visibility }),
            ...(accessLevel && { accessLevel }),
            ...(image && { image }),
            updatedAt: new Date().toISOString(),
          },
        };

        const result = await lessonsCollection.updateOne(query, updatedDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });
    // Report Lesson API
    app.post("/lessonsReports", async (req, res) => {
      const report = req.body;
      const result = await reportCollection.insertOne(report);
      res.send(result);
    });
    //get report api
    app.get("/lessonsReports", verifyJWT, async (req, res) => {
      const reports = await reportCollection
        .aggregate([
          {
            $addFields: {
              lessonObjectId: { $toObjectId: "$lessonId" },
            },
          },
          {
            $lookup: {
              from: "lessons",
              localField: "lessonObjectId",
              foreignField: "_id",
              as: "lessonDetails",
            },
          },
          { $unwind: "$lessonDetails" },
          {
            $project: {
              lessonTitle: "$lessonDetails.title",
              lessonId: 1,
              reportedUserEmail: 1,
              reason: 1,
              timestamp: 1,
            },
          },
        ])
        .toArray();
      res.send(reports);
    });
    //delete report api
    app.delete("/lessonsReports/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await reportCollection.deleteOne(query);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
