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

    //save lesson to database
    app.post("/lessons", async (req, res) => {
      const newLesson = req.body;
      const result = await lessonsCollection.insertOne(newLesson);
      console.log(result);
      res.send(result);
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
                name: `Please pay for: ${paymentInfo.lessonTitle}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          lessonId: paymentInfo.lessonId,
        },
        customer_email: paymentInfo.customer.email,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}&lessonId=${paymentInfo.lessonId}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled${paymentInfo.lessonId}`,
      });
      console.log(paymentInfo);
      res.send({ url: session.url });
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(session.metadata.lessonId),
      });

      const paymentExists = await paymentsCollection.findOne({
        transactionId: session.payment_intent,
      });

      if (
        session.payment_status === "paid" &&
        session.status === "complete" &&
        !paymentExists
      ) {
        //save data in db
        const paymentRecord = {
          lessonId: session.metadata.lessonId,
          transactionId: session.payment_intent,
          customer: session.customer_email,
          status: "pending",
          lessonTitle: lesson.title,
        };
        const result = await paymentsCollection.insertOne(paymentRecord);
      }
      res.send({ message: "Payment verified successfully" });
      //  console.log(session);
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
      console.log(req.tokenEmail);

      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
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
            return res
              .status(403)
              .send({
                message: "You don't have permission to update this lesson",
              });
          }
        }

        if (accessLevel && accessLevel.toLowerCase() === "premium") {
          const user = await usersCollection.findOne({ email: req.tokenEmail });
          if (user.role !== "premium" && user.role !== "admin") {
            return res
              .status(403)
              .send({
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
