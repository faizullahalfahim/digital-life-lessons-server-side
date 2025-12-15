require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors({
  origin: [process.env.SITE_DOMAIN]
}));
app.use(express.json());
const port = 3000;

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
       console.log(paymentInfo)
      res.send({ url: session.url });
    });
    
    app.post('/payment-success',async (req, res) => { 
      const {sessionId} = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId); 

      const lesson = await lessonsCollection.findOne({ _id: new ObjectId(session.metadata.lessonId) });

      const paymentExists = await paymentsCollection.findOne({ transactionId: session.payment_intent });

      if(session.payment_status === 'paid' && session.status === 'complete' && !paymentExists){
       //save data in db
       const paymentRecord = {
        lessonId: session.metadata.lessonId,
        transactionId: session.payment_intent,
        customer: session.customer_email,
        status: 'pending',
        lessonTitle: lesson.title,
       }
        const result = await paymentsCollection.insertOne(paymentRecord);
      } 
      res.send({message: 'Payment verified successfully'});
    //  console.log(session);
    } )
    
    //get my lessons by email
    app.get("/my-lessons/:email", async(req, res) => {
      const email = req.params.email;
      const lessons = await lessonsCollection.find({
        creator: email
      }).toArray()
      res.send(lessons);
    })

    // save or update user info
    app.post("/users", async(req, res) => {
      const userData = req.body; 
      userData.createdAt = new Date().toISOString()
      userData.last_loggedIn = new Date().toISOString()
      userData.role = "user"
      const query = {
        email: userData.email,

      }
      const alreadyExists = await usersCollection.findOne({email:userData.email})
      console.log('user already exists ===> ' ,!!alreadyExists)
      if(alreadyExists) {
        console.log('updating user info ..' )
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date(). toISOString(),
          }
        })
        return res.send(result)
      }
      console.log('saving new user info')
 
     const result = await usersCollection.insertOne(userData)
      res.send(userData);
    })

    //get a user's role
    app.get('/user/role/:email' , async (req,res) => {
      const email = req.params.email
      const result= await usersCollection.findOne({email})
      res.send({role: result?.role})
    })


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
