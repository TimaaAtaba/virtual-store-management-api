const Order = require("../models/Order");
const Product = require("../models/Product");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

/**
 * Populate helper - order + user details + products (and their category)
 */
const populateOrder = (query) =>
  query
    .populate("user", "fullName email phone role")
    .populate({
      path: "items.product",
      select: "name price stock category",
      populate: { path: "category", select: "name" },
    });

/**
 * @desc    Create a new order
 *          - verifies the user exists
 *          - verifies every product exists
 *          - verifies there is enough stock
 *          - calculates the price on the server side
 *          - decreases the stock atomically (with rollback on failure)
 * @route   POST /api/orders
 */
const createOrder = asyncHandler(async (req, res) => {
  const { user: userId, items, shippingAddress } = req.body;

  // 1. user must exist
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, "User not found");

  // 2. merge duplicated products in the request (same product sent twice)
  const mergedItems = new Map();
  for (const item of items) {
    const current = mergedItems.get(item.product) || 0;
    mergedItems.set(item.product, current + item.quantity);
  }

  const productIds = [...mergedItems.keys()];

  // 3. all products must exist
  const products = await Product.find({ _id: { $in: productIds } });
  if (products.length !== productIds.length) {
    const foundIds = products.map((p) => p._id.toString());
    const missing = productIds.filter((id) => !foundIds.includes(id));
    throw new ApiError(404, "Some products were not found", { missingProducts: missing });
  }

  // 4. stock check + server-side price calculation
  const orderItems = [];
  const outOfStock = [];
  let totalPrice = 0;

  for (const product of products) {
    const quantity = mergedItems.get(product._id.toString());

    if (product.stock < quantity) {
      outOfStock.push({
        product: product._id,
        name: product.name,
        requested: quantity,
        available: product.stock,
      });
      continue;
    }

    const lineTotal = Number((product.price * quantity).toFixed(2));
    totalPrice += lineTotal;

    orderItems.push({
      product: product._id,
      quantity,
      unitPrice: product.price,
      lineTotal,
    });
  }

  if (outOfStock.length > 0) {
    throw new ApiError(400, "Not enough stock for some products", { outOfStock });
  }

  // 5. decrease the stock.
  //    The condition "stock >= quantity" is part of the update filter, so two
  //    parallel orders can never take the same last item (atomic operation).
  const restoreStock = (items) =>
    Promise.all(
      items.map((item) =>
        Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } })
      )
    );

  const takenItems = [];
  for (const item of orderItems) {
    const result = await Product.updateOne(
      { _id: item.product, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } }
    );

    if (result.modifiedCount === 0) {
      await restoreStock(takenItems); // rollback
      throw new ApiError(400, "Not enough stock for one of the products", {
        product: item.product,
        requested: item.quantity,
      });
    }

    takenItems.push(item);
  }

  // 6. create the order - if it fails, return the stock back
  let order;
  try {
    order = await Order.create({
      user: user._id,
      items: orderItems,
      totalPrice: Number(totalPrice.toFixed(2)),
      shippingAddress: shippingAddress || user.addresses?.[0],
    });
  } catch (error) {
    await restoreStock(takenItems);
    throw error;
  }

  const populated = await populateOrder(Order.findById(order._id));

  res.status(201).json({
    success: true,
    message: "Order created successfully",
    data: populated,
  });
});

/**
 * @desc    Get all orders (with user + products details)
 * @route   GET /api/orders
 */
const getOrders = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.user) filter.user = req.query.user;

  const orders = await populateOrder(Order.find(filter)).sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    count: orders.length,
    data: orders,
  });
});

/**
 * @desc    Get a single order with the related user and products
 * @route   GET /api/orders/:id
 */
const getOrderById = asyncHandler(async (req, res) => {
  const order = await populateOrder(Order.findById(req.params.id));
  if (!order) throw new ApiError(404, "Order not found");

  res.status(200).json({ success: true, data: order });
});

/**
 * @desc    Get all orders of a specific user
 * @route   GET /api/orders/user/:userId
 */
const getOrdersByUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) throw new ApiError(404, "User not found");

  const orders = await populateOrder(Order.find({ user: user._id })).sort({
    createdAt: -1,
  });

  const totalSpent = orders.reduce((sum, order) => sum + order.totalPrice, 0);

  res.status(200).json({
    success: true,
    user: { _id: user._id, fullName: user.fullName, email: user.email },
    count: orders.length,
    totalSpent: Number(totalSpent.toFixed(2)),
    data: orders,
  });
});

/**
 * @desc    Update the status of an order
 * @route   PATCH /api/orders/:id/status
 */
const updateOrderStatus = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, "Order not found");

  if (order.status === "cancelled") {
    throw new ApiError(400, "Cannot change the status of a cancelled order");
  }

  // cancelling an order returns its items back to stock
  if (req.body.status === "cancelled") {
    await Promise.all(
      order.items.map((item) =>
        Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } })
      )
    );
  }

  order.status = req.body.status;
  await order.save();

  const populated = await populateOrder(Order.findById(order._id));

  res.status(200).json({
    success: true,
    message: "Order status updated successfully",
    data: populated,
  });
});

/**
 * @desc    Cancel an order and return the products back to stock
 * @route   DELETE /api/orders/:id
 */
const deleteOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, "Order not found");

  // return the items back to stock (a cancelled order already returned them)
  if (order.status !== "cancelled") {
    await Promise.all(
      order.items.map((item) =>
        Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } })
      )
    );
  }

  await order.deleteOne();

  res.status(200).json({
    success: true,
    message: "Order deleted and stock restored successfully",
    data: order,
  });
});

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  getOrdersByUser,
  updateOrderStatus,
  deleteOrder,
};
