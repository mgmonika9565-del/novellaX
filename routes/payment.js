const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Ebook = require('../models/Ebook');

const razorpay = new Razorpay({
  key_id: process.env.RZP_KEY_ID,
  key_secret: process.env.RZP_KEY_SECRET
});

// Receiver UPI ID - All payments go here
const RECEIVER_UPI_ID = process.env.UPI_ID || 'vineet100776-1@okhdfcbank';

// Create payment order
router.post('/create-order', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Please login first' });

    const { bookId } = req.body;
    const ebook = await Ebook.findById(bookId);
    if (!ebook) return res.status(404).json({ error: 'Book not found' });

    // Check if user already purchased
    const user = await User.findById(req.user._id);
    const alreadyPurchased = user.purchasedBooks.some(b => b.bookId.toString() === bookId);
    if (alreadyPurchased) return res.status(400).json({ error: 'Already purchased' });

    const options = {
      amount: Math.round(ebook.price * 100), // Amount in paise
      currency: 'INR',
      receipt: `order_${Date.now()}`,
      payment_capture: 1,
      // UPI payment method configuration
      notes: {
        policy_name: 'novellaX Ebook Purchase',
        book_title: ebook.title,
        book_id: bookId.toString(),
        user_email: req.user.email,
        receiver_upi: RECEIVER_UPI_ID
      }
    };

    const order = await razorpay.orders.create(options);

    const payment = new Payment({
      userId: req.user._id,
      bookId,
      amount: ebook.price,
      razorpayOrderId: order.id,
      status: 'pending',
      paymentMethod: 'upi',
      upiId: RECEIVER_UPI_ID
    });
    await payment.save();

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RZP_KEY_ID,
      bookTitle: ebook.title,
      paymentMethod: 'upi',
      receiverUPI: RECEIVER_UPI_ID
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify payment
router.post('/verify', async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    const crypto = require('crypto');
    const body = razorpayOrderId + '|' + razorpayPaymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RZP_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature === razorpaySignature) {
      const payment = await Payment.findOneAndUpdate(
        { razorpayOrderId },
        { 
          razorpayPaymentId, 
          razorpaySignature, 
          status: 'completed',
          upiId: RECEIVER_UPI_ID
        },
        { new: true }
      );

      // Add book to user's purchased books
      await User.findByIdAndUpdate(
        payment.userId,
        {
          $push: {
            purchasedBooks: {
              bookId: payment.bookId,
              price: payment.amount
            }
          }
        }
      );

      // Update sales count
      await Ebook.findByIdAndUpdate(
        payment.bookId,
        { $inc: { sales: 1 } }
      );

      res.json({ 
        success: true, 
        message: 'Payment verified and book added to library',
        receivedAmount: payment.amount,
        receiverUPI: RECEIVER_UPI_ID
      });
    } else {
      res.status(400).json({ success: false, error: 'Invalid signature' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's purchased books
router.get('/purchased-books', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Please login first' });

    const user = await User.findById(req.user._id).populate('purchasedBooks.bookId');
    res.json(user.purchasedBooks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get payment history (User)
router.get('/history', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Please login first' });

    const payments = await Payment.find({ 
      userId: req.user._id,
      status: 'completed'
    }).populate('bookId');
    
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get all payments (Owner only)
router.get('/admin/all-payments', async (req, res) => {
  try {
    if (req.user?.email !== process.env.OWNER_EMAIL) {
      return res.status(403).json({ error: 'Only owner can access this' });
    }

    const payments = await Payment.find({ status: 'completed' })
      .populate('userId')
      .populate('bookId');
    
    const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
    
    res.json({
      totalPayments: payments.length,
      totalRevenue,
      receiverUPI: RECEIVER_UPI_ID,
      payments
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get revenue summary (Owner only)
router.get('/admin/revenue', async (req, res) => {
  try {
    if (req.user?.email !== process.env.OWNER_EMAIL) {
      return res.status(403).json({ error: 'Only owner can access this' });
    }

    const payments = await Payment.find({ status: 'completed' });
    
    const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
    const totalTransactions = payments.length;
    
    // Revenue by book
    const revenueByBook = {};
    for (let payment of payments) {
      const book = await Ebook.findById(payment.bookId);
      if (book) {
        if (!revenueByBook[book.title]) {
          revenueByBook[book.title] = 0;
        }
        revenueByBook[book.title] += payment.amount;
      }
    }

    res.json({
      totalRevenue,
      totalTransactions,
      averageTransactionValue: totalTransactions > 0 ? totalRevenue / totalTransactions : 0,
      receiverUPI: RECEIVER_UPI_ID,
      revenueByBook
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
